import {
  calculateModelCost,
  DEFAULT_MODEL_CAPABILITIES,
  DEFAULT_ROUTING_CONFIG,
  filterCandidatesByCapacity,
  getFallbackChain,
  route as routeRequest,
  type ModelPricing as RouterCoreModelPricing,
} from "@blockrun/router-core";
import type {
  ChatCompletionOptions,
  ChatMessage,
  RoutingDecision,
  RoutingProfile,
  SearchParameters,
  Tool,
} from "./types";
import { APIError, PaymentError, retryDisposition } from "./types";

const AUTO_ROUTING_PROFILES: Readonly<Record<string, RoutingProfile>> = {
  "blockrun/auto": "auto",
  "blockrun/eco": "eco",
  "blockrun/premium": "premium",
};

/** x402 per-request payment floors, used only for cost METADATA (the real
 * charge is always the gateway's 402 quote). Free models settle at $0 and
 * are never floored. */
export const BASE_MINIMUM_PAYMENT_USD = 0.002;
export const SOLANA_MINIMUM_PAYMENT_USD = 0.001;

/**
 * A catalog pricing entry: the bundled router's pricing shape plus the
 * gateway's platform fee. `platformFeePercent` is set only on per-token paid
 * chat rows (see {@link platformFeePercentOf}); the router ignores it, and
 * {@link estimateChatCostUsd} applies it.
 */
export type ModelPricing = RouterCoreModelPricing & { platformFeePercent?: number };

/** A `/v1/models` row as either gateway emits it, or as the SDK maps it. */
export interface PlatformFeeRow {
  billing_mode?: string;
  billingMode?: string;
  platform_fee_percent?: unknown;
  platformFeePercent?: unknown;
  pricing?: { platform_fee_percent?: unknown; flat?: unknown } | null;
}

/**
 * The platform fee, in percent, that an x402 call to this `/v1/models` row
 * pays on top of its per-token `pricing.input` / `pricing.output` (which stay
 * at the vendor's list price). Spec: BlockRunAI/blockrun
 * specs/2026-11-16-chat-platform-fee.md PF-8.
 *
 * Read from `pricing.platform_fee_percent` (sol.blockrun.ai and blockrun.ai),
 * then the row's top-level `platform_fee_percent` (blockrun.ai), then the
 * SDK-mapped `platformFeePercent`. The first finite, non-negative number wins.
 *
 * 0 when the field is absent (older gateways and enterprise, PF-9, do not
 * send it), and always 0 for a row that is not per-token paid chat: free,
 * flat (a flat price is final) and media rows never pay it.
 */
export function platformFeePercentOf(row: PlatformFeeRow | null | undefined): number {
  if (!row) return 0;
  const mode = row.billingMode ?? row.billing_mode;
  if (mode !== undefined && mode !== "paid") return 0;
  if (row.pricing?.flat !== undefined && row.pricing.flat !== null) return 0;
  for (const value of [row.pricing?.platform_fee_percent, row.platform_fee_percent, row.platformFeePercent]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

/**
 * Estimated USD cost of one chat call against a catalog pricing entry, before
 * any payment floor: a flat price as-is, otherwise the per-token list cost
 * times `(1 + platformFeePercent / 100)`. The real charge is always the
 * gateway's 402 quote; this is metadata for routing and budgeting.
 */
export function estimateChatCostUsd(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
): number {
  if (pricing.flatPrice !== undefined) return pricing.flatPrice;
  const fee = pricing.platformFeePercent;
  const factor = typeof fee === "number" && Number.isFinite(fee) && fee >= 0 ? 1 + fee / 100 : 1;
  return ((inputTokens / 1e6) * pricing.inputPrice + (outputTokens / 1e6) * pricing.outputPrice) * factor;
}

/**
 * Whether an error is the kind of transient failure that warrants trying the
 * next model in a fallback chain.
 *
 * Only an error whose request layer marked it `"unpaid"` qualifies (see
 * {@link RetryDisposition}): the next model is a new paid request, so moving
 * on after a payment that may have been charged could pay twice. An error
 * with no disposition is never transient.
 *
 * Among unpaid errors, true for: AbortError (timeout), generic network/fetch
 * errors, 429 (this upstream is saturated — the next model in the chain is a
 * different upstream), and 5xx availability errors. False for: other 4xx
 * client errors (bad request, auth) and PaymentError — those aren't "swap
 * upstream and retry" situations. Shared by both chain clients so the
 * transient set cannot drift between them.
 */
export function isTransientError(err: unknown): boolean {
  if (retryDisposition(err) !== "unpaid") return false;
  if (err instanceof PaymentError) return false;
  if (err instanceof APIError) {
    return [429, 502, 503, 504, 522, 524].includes(err.statusCode);
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if (err.name === "TypeError" && /fetch|network/i.test(err.message)) return true;
  }
  return false;
}

/** One-line error summary for fallback-hop logging. */
export function errSummary(err: unknown): string {
  if (err instanceof APIError) return `APIError ${err.statusCode}`;
  if (err instanceof Error) {
    const msg = err.message.length > 80 ? err.message.slice(0, 80) : err.message;
    return `${err.name}: ${msg}`;
  }
  return String(err).slice(0, 100);
}

/**
 * Whether a call asks for xAI search: an `x_search` / `web_search` tool, or
 * search parameters that are not `mode: "off"` (or the `search: true`
 * shortcut, used only when no `searchParameters` are given — the same
 * precedence the request body follows). The gateway serves search on `xai/*`
 * models only and answers any other model with a non-transient 400
 * `SEARCH_UNSUPPORTED_MODEL`, so routing must stay on `xai/*`.
 */
export function requestsSearch(options: {
  search?: boolean;
  searchParameters?: SearchParameters;
  tools?: ChatCompletionOptions["tools"];
}): boolean {
  if (options.tools?.some((tool) => tool.type === "x_search" || tool.type === "web_search")) return true;
  if (options.searchParameters !== undefined) return options.searchParameters.mode !== "off";
  return options.search === true;
}

/**
 * The catalog's search-capable xAI chat models, keyed by the pricing map the
 * client built from the same catalog. Registered by {@link registerSearchModels}
 * so routing can fall back to one without changing the pricing map's
 * router-core shape.
 */
const searchModelsByCatalog = new WeakMap<Map<string, ModelPricing>, string[]>();

/**
 * Record which catalog models can serve search, for {@link routeWithCatalog}:
 * available `xai/*` chat models, preferring those the catalog tags `search`
 * (all `xai/*` chat models when none is tagged). The gateway serves search on
 * any `xai/*` id, but the tag marks the models built for it.
 */
export function registerSearchModels(
  pricing: Map<string, ModelPricing>,
  models: ReadonlyArray<{ id: string; categories?: string[]; available?: boolean }>,
): void {
  const xaiChat = models.filter(
    (m) =>
      m.id.startsWith("xai/") &&
      m.available !== false &&
      Array.isArray(m.categories) &&
      m.categories.includes("chat") &&
      pricing.has(m.id),
  );
  const tagged = xaiChat.filter((m) => m.categories!.includes("search"));
  searchModelsByCatalog.set(pricing, (tagged.length > 0 ? tagged : xaiChat).map((m) => m.id));
}

/**
 * The search fallback when the route has no `xai/*` candidate: the cheapest
 * search-capable model (premium: the most capable, read as the priciest),
 * then the rest in that order. Ties go to the newer id.
 */
function searchFallbackChain(
  modelPricing: Map<string, ModelPricing>,
  routingProfile: RoutingProfile | undefined,
): string[] {
  const pool =
    searchModelsByCatalog.get(modelPricing) ??
    [...modelPricing.keys()].filter((id) => id.startsWith("xai/"));
  const price = (id: string) => {
    const p = modelPricing.get(id);
    return p ? p.inputPrice + p.outputPrice : Number.POSITIVE_INFINITY;
  };
  const sorted = [...pool].sort((a, b) => price(a) - price(b) || b.localeCompare(a, undefined, { numeric: true }));
  if (routingProfile !== "premium") return sorted;
  return [...pool].sort((a, b) => price(b) - price(a) || b.localeCompare(a, undefined, { numeric: true }));
}

export function routingProfileForModel(model: string): RoutingProfile | undefined {
  return AUTO_ROUTING_PROFILES[model.toLowerCase()];
}

export function routingText(messages: ChatMessage[]): {
  prompt: string;
  systemPrompt: string | undefined;
  /** Size of the FULL conversation payload — routing capacity checks must
   * see the whole transcript, not just the last user message. */
  conversationChars: number;
  /** True when any message carries image content parts. */
  hasVision: boolean;
} {
  const systemPrompt =
    messages
      .filter((message) => message.role === "system" && typeof message.content === "string")
      .map((message) => message.content as string)
      .join("\n") || undefined;
  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user" && typeof message.content === "string");
  const lastText = [...messages]
    .reverse()
    .find((message) => typeof message.content === "string");
  let conversationChars = 0;
  let hasVision = false;
  for (const message of messages) {
    if (typeof message.content === "string") {
      conversationChars += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; text?: string }>) {
        if (part?.type === "image_url" || part?.type === "image") hasVision = true;
        if (typeof part?.text === "string") conversationChars += part.text.length;
      }
    }
  }
  return {
    prompt: (lastUser?.content ?? lastText?.content ?? "") as string,
    systemPrompt,
    conversationChars,
    hasVision,
  };
}

export function routeWithCatalog(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  modelPricing: Map<string, ModelPricing>,
  options: {
    routingProfile?: RoutingProfile;
    requiresStructuredOutput?: boolean;
    tools?: ChatCompletionOptions["tools"];
    toolChoice?: ChatCompletionOptions["toolChoice"];
    /** Live Search shortcut / parameters: when they ask for search, only `xai/*` candidates are kept. */
    search?: boolean;
    searchParameters?: SearchParameters;
    minimumPaymentUsd?: number;
    /** Full-conversation size for capacity filtering; defaults to the
     * routing prompt when the call has no wider transcript. */
    conversationChars?: number;
    hasVision?: boolean;
  } = {},
): RoutingDecision {
  // Only function tools shape routing; x_search / web_search run server-side on xai/*.
  const tools = (options.tools ?? []).filter((tool): tool is Tool => tool.type === "function");
  const requiresTools =
    options.toolChoice === "none"
      ? false
      : options.toolChoice === "required" || typeof options.toolChoice === "object"
        ? true
        : undefined;
  const decision = routeRequest(prompt, systemPrompt, maxOutputTokens, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
    routingProfile: options.routingProfile,
    hasTools: tools.length > 0,
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.function.name),
    requiresTools,
    hasVision: options.hasVision,
    requiresStructuredOutput: options.requiresStructuredOutput,
  });

  // Turn the ranking into a gateway-callable list. The ranking is trusted
  // as-is — including ids withheld from /v1/models (e.g. moonshot/kimi-k2.7),
  // which the gateway serves by direct id — with one exception: the router
  // names its free tier `free/<model>`, a namespace resolved by ClawRouter's
  // proxy. The gateway's ids are `nvidia/<model>`, and an unmapped `free/*`
  // id draws a hard 400 (non-transient, so the fallback chain would never
  // engage). Map `free/*` to its catalog-listed `nvidia/*` id and drop it
  // when there is none (the proxy-only gpt-oss pair).
  const tierConfigs = decision.tierConfigs ?? DEFAULT_ROUTING_CONFIG.tiers;
  const ranked = decision.candidates?.length
    ? decision.candidates
    : [decision.model, ...getFallbackChain(decision.tier, tierConfigs)];
  const callable: string[] = [];
  for (const id of ranked) {
    const resolved = !id.startsWith("free/")
      ? id
      : modelPricing.has(`nvidia/${id.slice(5)}`)
        ? `nvidia/${id.slice(5)}`
        : null;
    if (resolved && !callable.includes(resolved)) callable.push(resolved);
  }

  // Search runs on xai/* only: the gateway refuses any other model with a
  // non-transient 400, so a non-xai pick (or fallback) would fail outright.
  // Keep the router's order among the xai/* candidates. When the route has
  // none (the common case: the router seldom ranks xAI), fall back to the
  // catalog's search-capable xAI models, cheapest first (premium: most
  // capable first). Only with no xAI model in the catalog at all does it
  // fail, before any request is sent or paid. Nothing else about the
  // candidate policy changes.
  let searchFallback = false;
  if (requestsSearch(options)) {
    let searchable = callable.filter((id) => id.startsWith("xai/"));
    if (searchable.length === 0) {
      searchable = searchFallbackChain(modelPricing, options.routingProfile);
      searchFallback = true;
    }
    if (searchable.length === 0) {
      throw new Error(
        `Search (x_search / web_search tools or searchParameters) runs on xai/* models only, and the ` +
          `catalog lists no available xai/* chat model. Call an xai/* model directly or drop the search options.`,
      );
    }
    callable.splice(0, callable.length, ...searchable);
  }

  // Capacity check against the FULL conversation, not just the routing
  // prompt — an agent transcript can be 100x the last user message, and a
  // context overflow is a non-transient 400 the fallback chain won't save.
  // Models unknown to the capability snapshot are kept (benefit of the doubt).
  const estimatedInputTokens = Math.ceil(
    Math.max(options.conversationChars ?? 0, `${systemPrompt ?? ""} ${prompt}`.length) / 4,
  );
  const fitting = filterCandidatesByCapacity(
    callable,
    estimatedInputTokens,
    maxOutputTokens,
    (id) => {
      const caps = DEFAULT_MODEL_CAPABILITIES[id];
      return caps ? { contextWindow: caps.contextWindow, maxOutput: caps.maxOutputTokens } : undefined;
    },
  );
  const availableCandidates = fitting.length > 0 ? fitting : callable;

  // If nothing survived (a chain of proxy-only free ids), call the router's
  // pick as-is so the gateway's real error surfaces rather than an invented
  // one here.
  const model = availableCandidates[0] ?? decision.model;

  const costs = calculateModelCost(
    model,
    modelPricing,
    estimatedInputTokens,
    maxOutputTokens,
    options.routingProfile,
  );
  const minimumPaymentUsd = options.minimumPaymentUsd ?? SOLANA_MINIMUM_PAYMENT_USD;
  // Free models settle at $0 (no payment is signed) — never floor them up to
  // the paid minimum. Detected from the catalog pricing, because router-core's
  // calculateModelCost applies its own internal floor even to $0 models.
  const entry = modelPricing.get(model);
  const isFree =
    entry !== undefined && entry.inputPrice === 0 && entry.outputPrice === 0 && !entry.flatPrice;
  // A catalog-priced model is costed here, from the catalog: router-core's
  // calculateModelCost multiplies every model (flat ones included) by a fixed
  // internal margin, while the gateway publishes the real fee per row
  // (platform_fee_percent, PF-8) and charges none on flat rows. An id the
  // catalog does not list keeps router-core's figure.
  const usable =
    entry !== undefined &&
    [entry.inputPrice, entry.outputPrice, entry.flatPrice ?? 0].every((v) => Number.isFinite(v) && v >= 0);
  const modelCost = usable
    ? estimateChatCostUsd(entry, estimatedInputTokens, maxOutputTokens)
    : costs.costEstimate;
  const costEstimate = isFree ? 0 : Math.max(modelCost, minimumPaymentUsd);
  const savings =
    options.routingProfile === "premium" || costs.baselineCost <= 0
      ? 0
      : entry !== undefined
        ? Math.max(0, (costs.baselineCost - costEstimate) / costs.baselineCost)
        : decision.savings;
  return {
    ...decision,
    ...costs,
    costEstimate,
    savings,
    model,
    reasoning: searchFallback
      ? `${decision.reasoning} | search runs on xai/* only; the route had none, so the ${
          options.routingProfile === "premium" ? "most capable" : "cheapest"
        } search-capable xAI model: ${model}`
      : model === decision.model
        ? decision.reasoning
        : `${decision.reasoning} | catalog fallback: ${model}`,
    candidates: availableCandidates,
    candidateScores: decision.candidateScores?.filter((score) =>
      availableCandidates.includes(score.model),
    ),
    fallbacks: availableCandidates.slice(1),
  };
}
