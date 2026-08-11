import {
  calculateModelCost,
  DEFAULT_MODEL_CAPABILITIES,
  DEFAULT_ROUTING_CONFIG,
  filterCandidatesByCapacity,
  getFallbackChain,
  route as routeRequest,
  type ModelPricing,
} from "@blockrun/router-core";
import type {
  ChatCompletionOptions,
  ChatMessage,
  RoutingDecision,
  RoutingProfile,
} from "./types";
import { APIError, PaymentError } from "./types";

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

export type { ModelPricing };

/**
 * Whether an error is the kind of transient failure that warrants trying the
 * next model in a fallback chain. True for: AbortError (timeout), generic
 * network/fetch errors, 429 (this upstream is saturated — the next model in
 * the chain is a different upstream), and 5xx availability errors.
 *
 * False for: other 4xx client errors (bad request, auth) and PaymentError —
 * those aren't "swap upstream and retry" situations. Shared by both chain
 * clients so the transient set cannot drift between them.
 */
export function isTransientError(err: unknown): boolean {
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
    minimumPaymentUsd?: number;
    /** Full-conversation size for capacity filtering; defaults to the
     * routing prompt when the call has no wider transcript. */
    conversationChars?: number;
    hasVision?: boolean;
  } = {},
): RoutingDecision {
  const tools = options.tools ?? [];
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
  const costEstimate = isFree ? 0 : Math.max(costs.costEstimate, minimumPaymentUsd);
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
    reasoning:
      model === decision.model
        ? decision.reasoning
        : `${decision.reasoning} | catalog fallback: ${model}`,
    candidates: availableCandidates,
    candidateScores: decision.candidateScores?.filter((score) =>
      availableCandidates.includes(score.model),
    ),
    fallbacks: availableCandidates.slice(1),
  };
}
