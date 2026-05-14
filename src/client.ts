/**
 * BlockRun LLM Client - Main SDK entry point.
 *
 * Usage:
 *   import { LLMClient } from '@blockrun/llm';
 *
 *   // Option 1: Use BASE_CHAIN_WALLET_KEY env var
 *   const client = new LLMClient();
 *
 *   // Option 2: Pass private key directly
 *   const client = new LLMClient({ privateKey: '0x...' });
 *
 *   const response = await client.chat('openai/gpt-5.2', 'Hello!');
 *   console.log(response);
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type ChatMessage,
  type ChatResponse,
  type ChatOptions,
  type ChatCompletionOptions,
  type LLMClientOptions,
  type Model,
  type ImageModel,
  type ImageResponse,
  type ImageEditOptions,
  type Spending,
  type SmartChatOptions,
  type SmartChatResponse,
  type RoutingDecision,
  type SearchResult,
  type SearchOptions,
  type ExaSearchOptions,
  type ExaSearchResponse,
  type ExaAnswerResponse,
  type ExaContentsResponse,
  type ExaFindSimilarOptions,
  type XUserLookupResponse,
  type XFollowersResponse,
  type XFollowingsResponse,
  type XUserInfoResponse,
  type XVerifiedFollowersResponse,
  type XTweetsResponse,
  type XMentionsResponse,
  type XTweetLookupResponse,
  type XTweetRepliesResponse,
  type XTweetThreadResponse,
  type XSearchResponse,
  type XTrendingResponse,
  type XArticlesRisingResponse,
  type XAuthorAnalyticsResponse,
  type XCompareAuthorsResponse,
  APIError,
  PaymentError,
} from "./types";
import { route, DEFAULT_ROUTING_CONFIG, getFallbackChain } from "@blockrun/clawrouter";

// Model pricing type for ClawRouter (matches @blockrun/clawrouter internal type)
type ModelPricing = {
  inputPrice: number;  // per 1M tokens
  outputPrice: number; // per 1M tokens
};

/**
 * Whether an error is the kind of transient failure that warrants trying
 * the next model in a fallback chain. True for: AbortError (timeout),
 * generic network/fetch errors, and APIError with 5xx status codes
 * typically associated with upstream availability problems.
 *
 * False for: 4xx client errors (bad request, auth) and PaymentError —
 * those aren't "swap upstream and retry" situations.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof PaymentError) return false;
  if (err instanceof APIError) {
    return [502, 503, 504, 522, 524].includes(err.statusCode);
  }
  // AbortError (timeout) or generic TypeError: failed to fetch
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if (err.name === "TypeError" && /fetch|network/i.test(err.message)) return true;
  }
  return false;
}

function errSummary(err: unknown): string {
  if (err instanceof APIError) return `APIError ${err.statusCode}`;
  if (err instanceof Error) {
    const msg = err.message.length > 80 ? err.message.slice(0, 80) : err.message;
    return `${err.name}: ${msg}`;
  }
  return String(err).slice(0, 100);
}

/**
 * Normalise a raw `/v1/models` row into the SDK `Model` interface.
 *
 * The route emits snake_case keys and nests pricing under `pricing.{input,
 * output, flat}`. This helper flattens both legacy and current shapes so the
 * SDK surface stays stable. Unknown / missing fields fall back to safe
 * defaults so callers don't have to handle undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRawToModel(m: any): Model {
  return {
    id: m.id,
    name: m.name || m.id,
    provider: m.provider || m.owned_by || "",
    description: m.description || "",
    inputPrice: m.inputPrice ?? m.input_price ?? m.pricing?.input ?? 0,
    outputPrice: m.outputPrice ?? m.output_price ?? m.pricing?.output ?? 0,
    contextWindow: m.contextWindow ?? m.context_window ?? 0,
    maxOutput: m.maxOutput ?? m.max_output ?? 0,
    categories: m.categories || [],
    available: true,
    billingMode: m.billingMode ?? m.billing_mode,
    flatPrice: m.flatPrice ?? m.flat_price ?? m.pricing?.flat,
    hidden: m.hidden,
  };
}

/**
 * Normalise a raw `/v1/models` row tagged with `categories: ["image"]`
 * into the SDK `ImageModel` interface. Image rows price per-image rather
 * than per-token, surfaced via `pricing.flat` (or legacy `price_per_image`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRawToImageModel(m: any): ImageModel {
  return {
    id: m.id,
    name: m.name || m.id,
    provider: m.provider || m.owned_by || "",
    description: m.description || "",
    pricePerImage:
      m.pricePerImage ?? m.price_per_image ?? m.pricing?.flat ?? m.flatPrice ?? m.flat_price ?? 0,
    supportedSizes: m.supportedSizes ?? m.supported_sizes,
    maxPromptLength: m.maxPromptLength ?? m.max_prompt_length,
    available: true,
  };
}
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "./x402";
import {
  validatePrivateKey,
  validateApiUrl,
  sanitizeErrorResponse,
  validateResourceUrl,
} from "./validation";
import { logCost } from "./cost-log";

const DEFAULT_API_URL = "https://blockrun.ai/api";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT = 60000;

// SDK version for User-Agent header (client identification in server logs)
const SDK_VERSION = "1.5.0";
const USER_AGENT = `blockrun-ts/${SDK_VERSION}`;

/**
 * BlockRun LLM Gateway Client.
 *
 * Provides access to multiple LLM providers (OpenAI, Anthropic, Google, etc.)
 * with automatic x402 micropayments on Base chain (Mainnet, Chain ID 8453).
 * API base: https://blockrun.ai/api
 */
export class LLMClient {
  static readonly DEFAULT_API_URL = DEFAULT_API_URL;
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;
  private modelPricingCache: Map<string, ModelPricing> | null = null;
  private modelPricingPromise: Promise<Map<string, ModelPricing>> | null = null;

  // Pre-auth cache: avoids the 402 round-trip on repeat requests to the same model.
  // Key = "endpoint:model", value = cached payment header + timestamp.
  // TTL: 1 hour (mirrors ClawRouter's payment-preauth.ts approach).
  private preAuthCache: Map<string, { paymentHeader: string; cachedAt: number }> = new Map();
  private static readonly PRE_AUTH_TTL_MS = 3_600_000;

  /**
   * Initialize the BlockRun LLM client.
   *
   * @param options - Client configuration options (optional if BASE_CHAIN_WALLET_KEY env var is set)
   */
  constructor(options: LLMClientOptions = {}) {
    // Get private key from options or environment variable (browser-safe check)
    const envKey = typeof process !== "undefined" && process.env
      ? process.env.BASE_CHAIN_WALLET_KEY
      : undefined;
    const privateKey = options.privateKey || envKey;

    if (!privateKey) {
      throw new Error(
        "Private key required. Pass privateKey in options or set BASE_CHAIN_WALLET_KEY environment variable."
      );
    }

    // Validate private key format
    validatePrivateKey(privateKey);

    // Store private key for signing (never transmitted)
    this.privateKey = privateKey as `0x${string}`;

    // Initialize wallet account (key stays local, never transmitted)
    this.account = privateKeyToAccount(privateKey as `0x${string}`);

    // Validate and set API URL
    const apiUrl = options.apiUrl || DEFAULT_API_URL;
    validateApiUrl(apiUrl);
    this.apiUrl = apiUrl.replace(/\/$/, "");

    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  /**
   * Simple 1-line chat interface.
   *
   * @param model - Model ID (e.g., 'openai/gpt-5.2', 'anthropic/claude-sonnet-4.6')
   * @param prompt - User message
   * @param options - Optional chat parameters
   * @returns Assistant's response text
   *
   * @example
   * const response = await client.chat('gpt-5.2', 'What is the capital of France?');
   * console.log(response); // 'The capital of France is Paris.'
   */
  async chat(model: string, prompt: string, options?: ChatOptions): Promise<string> {
    const messages: ChatMessage[] = [];

    if (options?.system) {
      messages.push({ role: "system", content: options.system });
    }

    messages.push({ role: "user", content: prompt });

    const result = await this.chatCompletion(model, messages, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      topP: options?.topP,
      search: options?.search,
      searchParameters: options?.searchParameters,
      fallbackModels: options?.fallbackModels,
    });

    return result.choices[0].message.content || "";
  }

  /**
   * Smart chat with automatic model routing.
   *
   * Uses ClawRouter's 14-dimension rule-based scoring algorithm (<1ms, 100% local)
   * to select the cheapest model that can handle your request.
   *
   * @param prompt - User message
   * @param options - Optional chat and routing parameters
   * @returns SmartChatResponse with response text, selected model, and routing metadata
   *
   * @example Simple usage (auto profile)
   * ```ts
   * const result = await client.smartChat('What is 2+2?');
   * console.log(result.response); // '4'
   * console.log(result.model); // 'google/gemini-2.5-flash-lite'
   * console.log(result.routing.savings); // 0.78 (78% savings)
   * ```
   *
   * @example With routing profile
   * ```ts
   * // Free tier only (zero cost)
   * const result = await client.smartChat('Hello!', { routingProfile: 'free' });
   *
   * // Eco mode (budget optimized)
   * const result = await client.smartChat('Explain quantum computing', { routingProfile: 'eco' });
   *
   * // Premium mode (best quality)
   * const result = await client.smartChat('Write a business plan', { routingProfile: 'premium' });
   * ```
   */
  async smartChat(prompt: string, options?: SmartChatOptions): Promise<SmartChatResponse> {
    // Get model pricing (cached after first call)
    const modelPricing = await this.getModelPricing();

    // Determine max output tokens for cost estimation
    const maxOutputTokens = options?.maxOutputTokens || options?.maxTokens || 1024;

    // Route the request using ClawRouter
    const decision = route(prompt, options?.system, maxOutputTokens, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing,
      routingProfile: options?.routingProfile,
    });

    // Compute fallback chain for the chosen tier — these are the models
    // chat() will walk to if the primary returns a transient error (timeout,
    // network, 5xx). Excludes the primary itself, and skips models the
    // catalog doesn't price (so we don't end up calling something we can't
    // estimate cost for).
    const tierConfigs = decision.tierConfigs ?? DEFAULT_ROUTING_CONFIG.tiers;
    const fullChain = getFallbackChain(decision.tier, tierConfigs);
    const fallbacks = fullChain.filter(
      (id) => id !== decision.model && modelPricing.has(id),
    );

    // Make the chat request with the selected model, passing the fallback
    // chain so transient failures fall over instead of bubbling up.
    const response = await this.chat(decision.model, prompt, {
      system: options?.system,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      topP: options?.topP,
      search: options?.search,
      searchParameters: options?.searchParameters,
      fallbackModels: fallbacks,
    });

    return {
      response,
      model: decision.model,
      routing: { ...(decision as RoutingDecision), fallbacks },
    };
  }

  /**
   * Get model pricing map (cached).
   * Fetches from API on first call, then returns cached result.
   */
  private async getModelPricing(): Promise<Map<string, ModelPricing>> {
    // Return cached pricing if available
    if (this.modelPricingCache) {
      return this.modelPricingCache;
    }

    // If already fetching, wait for that promise
    if (this.modelPricingPromise) {
      return this.modelPricingPromise;
    }

    // Fetch and cache
    this.modelPricingPromise = this.fetchModelPricing();
    try {
      this.modelPricingCache = await this.modelPricingPromise;
      return this.modelPricingCache;
    } finally {
      this.modelPricingPromise = null;
    }
  }

  /**
   * Fetch model pricing from API.
   *
   * For flat-billed models (e.g. ZAI GLM-5 family at $0.001/call) the
   * router still expects per-token rates, so we synthesise an equivalent
   * per-token price assuming ~1500 total tokens per call. Without this,
   * flat models would resolve to inputPrice=outputPrice=0 and the router
   * would treat them as free, biasing routing decisions and reporting
   * inflated savings %.
   */
  private async fetchModelPricing(): Promise<Map<string, ModelPricing>> {
    const models = await this.listModels();
    const pricing = new Map<string, ModelPricing>();

    for (const model of models) {
      if (model.billingMode === "flat" && model.flatPrice && model.flatPrice > 0) {
        const perDirection = (model.flatPrice * 1e6) / 1500 / 2;
        pricing.set(model.id, {
          inputPrice: perDirection,
          outputPrice: perDirection,
        });
      } else {
        pricing.set(model.id, {
          inputPrice: model.inputPrice,
          outputPrice: model.outputPrice,
        });
      }
    }

    return pricing;
  }

  /**
   * Full chat completion interface (OpenAI-compatible).
   *
   * When `fallbackModels` is set, transient failures (timeouts, network
   * errors, 5xx) on the primary model trigger a retry against the next
   * model in the list before raising. 4xx errors and PaymentError
   * propagate immediately — those aren't "swap upstream and retry"
   * situations. Each fallback hop logs one stderr line.
   *
   * @param model - Primary model ID
   * @param messages - Array of messages with role and content
   * @param options - Optional completion parameters
   * @returns ChatResponse object with choices and usage
   */
  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    options?: ChatCompletionOptions
  ): Promise<ChatResponse> {
    const buildBody = (m: string): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: m,
        messages,
        max_tokens: options?.maxTokens || DEFAULT_MAX_TOKENS,
      };
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.topP !== undefined) body.top_p = options.topP;
      if (options?.searchParameters !== undefined) {
        body.search_parameters = options.searchParameters;
      } else if (options?.search === true) {
        body.search_parameters = { mode: "on" };
      }
      if (options?.tools !== undefined) body.tools = options.tools;
      if (options?.toolChoice !== undefined) body.tool_choice = options.toolChoice;
      return body;
    };

    const chain = [model, ...(options?.fallbackModels ?? [])];
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i];
      try {
        return await this.requestWithPayment("/v1/chat/completions", buildBody(candidate));
      } catch (err) {
        lastErr = err;
        const next = chain[i + 1];
        if (!next || !isTransientError(err)) throw err;
        console.error(
          `[@blockrun/llm] ${candidate} -> ${next} (${errSummary(err)})`,
        );
      }
    }
    throw lastErr;
  }

  /**
   * Write a canonical cost_log entry after a settled x402 payment.
   * Best-effort: failures here must never break a successful API call.
   * Mirrors what Franklin's AgentClient writes via src/agent/llm.ts so
   * cost_log.jsonl is a single source of truth regardless of caller.
   */
  private recordCost(
    url: string,
    costUsd: number,
    opts?: { body?: Record<string, unknown>; network?: string },
  ): void {
    try {
      let endpoint = "";
      try { endpoint = new URL(url).pathname; } catch { endpoint = ""; }
      const model = opts?.body && typeof opts.body.model === "string" ? opts.body.model : undefined;
      logCost({
        ts: Date.now() / 1000,
        endpoint,
        cost_usd: costUsd,
        model,
        wallet: this.account.address,
        network: opts?.network,
        client_kind: "LLMClient",
      });
    } catch { /* never propagate */ }
  }

  /**
   * Parse the chat response JSON and attach `fallback` metadata when the
   * gateway signalled a transparent free-fallback substitution. The
   * gateway sets X-Fallback-Used / X-Fallback-Model / X-Settlement-Skipped
   * on the response when it served a paid request from a free model
   * (route.ts createPaymentResponseHeader path). Without surfacing these
   * to the caller, the user gets a different model than requested with
   * no visibility — silent quality drop and no clue why the on-chain
   * balance didn't change.
   */
  private async parseChatResponse(response: Response): Promise<ChatResponse> {
    const body = (await response.json()) as ChatResponse;
    const used = response.headers.get("X-Fallback-Used") === "true";
    if (used) {
      body.fallback = {
        used: true,
        model: response.headers.get("X-Fallback-Model") || undefined,
        settlementSkipped: response.headers.get("X-Settlement-Skipped") === "free-fallback",
      };
    }
    return body;
  }

  /**
   * Make a request with automatic x402 payment handling.
   */
  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<ChatResponse> {
    const url = `${this.apiUrl}${endpoint}`;

    // First attempt (will likely return 402)
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    });

    // Auto-retry on transient server errors (502/503)
    if (response.status === 502 || response.status === 503) {
      await new Promise(r => setTimeout(r, 1000));
      const retryResp = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify(body),
      });
      if (retryResp.status !== 502 && retryResp.status !== 503) {
        if (retryResp.status === 402) return this.handlePaymentAndRetry(url, body, retryResp);
        if (!retryResp.ok) {
          let errorBody: unknown;
          try { errorBody = await retryResp.json(); } catch { errorBody = { error: "Request failed" }; }
          throw new APIError(`API error: ${retryResp.status}`, retryResp.status, sanitizeErrorResponse(errorBody));
        }
        return this.parseChatResponse(retryResp);
      }
    }

    // Handle 402 Payment Required
    if (response.status === 402) {
      return this.handlePaymentAndRetry(url, body, response);
    }

    // Handle other errors
    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error: ${response.status}`,
        response.status,
        sanitizeErrorResponse(errorBody)
      );
    }

    return this.parseChatResponse(response);
  }

  /**
   * Handle 402 response: parse requirements, sign payment, retry.
   */
  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<ChatResponse> {
    // Get payment required header (x402 library uses lowercase)
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      // Try to get from response body
      try {
        const respBody = await response.json() as Record<string, unknown>;
        if (respBody.x402 || respBody.accepts) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch (parseError) {
        // Log for debugging but don't expose to user
        console.debug("Failed to parse payment header from response body", parseError);
      }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    // Parse payment requirements
    const paymentRequired = parsePaymentRequired(paymentHeader);

    // Extract payment details
    const details = extractPaymentDetails(paymentRequired);

    // Create signed payment payload (v2 format)
    // Pass through extensions from server (for Bazaar discovery)
    const extensions = ((paymentRequired as unknown) as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
    const paymentPayload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || `${this.apiUrl}/v1/chat/completions`,
          this.apiUrl
        ),
        resourceDescription: details.resource?.description || "BlockRun AI API call",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
        extensions,
      }
    );

    // Retry with payment (x402 library expects PAYMENT-SIGNATURE header)
    const retryResponse = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body),
    });

    // Auto-retry on transient server errors (502/503) after payment
    if (retryResponse.status === 502 || retryResponse.status === 503) {
      await new Promise(r => setTimeout(r, 1000));
      const retryResp2 = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "PAYMENT-SIGNATURE": paymentPayload,
        },
        body: JSON.stringify(body),
      });
      if (retryResp2.status !== 502 && retryResp2.status !== 503) {
        if (retryResp2.status === 402) throw new PaymentError("Payment was rejected. Check your wallet balance.");
        if (!retryResp2.ok) {
          let errorBody: unknown;
          try { errorBody = await retryResp2.json(); } catch { errorBody = { error: "Request failed" }; }
          throw new APIError(`API error after payment: ${retryResp2.status}`, retryResp2.status, sanitizeErrorResponse(errorBody));
        }
        const costUsd = parseFloat(details.amount) / 1e6;
        this.sessionCalls += 1;
        this.sessionTotalUsd += costUsd;
        this.recordCost(url, costUsd, { body, network: details.network });
        return this.parseChatResponse(retryResp2);
      }
    }

    // Check for errors
    if (retryResponse.status === 402) {
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
    }

    if (!retryResponse.ok) {
      let errorBody: unknown;
      try {
        errorBody = await retryResponse.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error after payment: ${retryResponse.status}`,
        retryResponse.status,
        sanitizeErrorResponse(errorBody)
      );
    }

    // Update session spending
    const costUsd = parseFloat(details.amount) / 1e6; // Convert from micro USDC
    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;
    this.recordCost(url, costUsd, { body, network: details.network });

    return this.parseChatResponse(retryResponse);
  }

  /**
   * Sign a payment header and return the PAYMENT-SIGNATURE value.
   * Extracted to share logic between streaming and non-streaming flows.
   */
  private async signPayment(paymentHeader: string): Promise<{ paymentPayload: string; costUsd: number }> {
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);
    const extensions = ((paymentRequired as unknown) as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
    const paymentPayload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || `${this.apiUrl}/v1/chat/completions`,
          this.apiUrl
        ),
        resourceDescription: details.resource?.description || "BlockRun AI API call",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
        extensions,
      }
    );
    const costUsd = parseFloat(details.amount) / 1e6;
    return { paymentPayload, costUsd };
  }

  /**
   * Streaming chat completion with automatic x402 payment.
   *
   * Uses a pre-auth cache so repeat calls to the same model skip the 402
   * round-trip (~200ms savings). Falls back to the normal 402 flow on cache
   * miss or if the pre-signed payment is rejected.
   *
   * @returns Raw fetch Response with a streaming SSE body.
   */
  async chatCompletionStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatCompletionOptions
  ): Promise<Response> {
    const url = `${this.apiUrl}/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.topP !== undefined) body.top_p = options.topP;
    if (options?.tools !== undefined) body.tools = options.tools;
    if (options?.toolChoice !== undefined) body.tool_choice = options.toolChoice;

    const cacheKey = `/v1/chat/completions:${model}`;
    const cached = this.preAuthCache.get(cacheKey);
    const now = Date.now();

    // --- Try pre-auth (skip 402 round-trip) ---
    if (cached && now - cached.cachedAt < LLMClient.PRE_AUTH_TTL_MS) {
      try {
        const { paymentPayload, costUsd } = await this.signPayment(cached.paymentHeader);
        const preAuthResp = await this.fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "PAYMENT-SIGNATURE": paymentPayload,
          },
          body: JSON.stringify(body),
        });
        if (preAuthResp.status !== 402 && preAuthResp.ok) {
          this.sessionCalls += 1;
          this.sessionTotalUsd += costUsd;
          return preAuthResp; // Pre-auth hit — no 402 round-trip
        }
        // Pre-auth rejected (price changed?) — evict and fall through
        this.preAuthCache.delete(cacheKey);
      } catch {
        this.preAuthCache.delete(cacheKey);
      }
    }

    // --- Normal flow: send request, handle 402, retry as stream ---
    const firstResp = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    });

    if (firstResp.status !== 402) {
      if (!firstResp.ok) {
        let errorBody: unknown;
        try { errorBody = await firstResp.json(); } catch { errorBody = { error: "Request failed" }; }
        throw new APIError(`API error: ${firstResp.status}`, firstResp.status, sanitizeErrorResponse(errorBody));
      }
      return firstResp;
    }

    // Parse 402, cache for next time, sign, and retry with stream
    let paymentHeader = firstResp.headers.get("payment-required");
    if (!paymentHeader) {
      try {
        const rb = await firstResp.json() as Record<string, unknown>;
        if (rb.x402 || rb.accepts) paymentHeader = btoa(JSON.stringify(rb));
      } catch { /* ignore */ }
    }
    if (!paymentHeader) throw new PaymentError("402 response but no payment requirements found");

    // Cache for pre-auth on future requests
    this.preAuthCache.set(cacheKey, { paymentHeader, cachedAt: now });

    const { paymentPayload, costUsd } = await this.signPayment(paymentHeader);

    const streamResp = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body),
    });

    if (streamResp.status === 402) throw new PaymentError("Payment was rejected. Check your wallet balance.");
    if (!streamResp.ok) {
      let errorBody: unknown;
      try { errorBody = await streamResp.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error after payment: ${streamResp.status}`, streamResp.status, sanitizeErrorResponse(errorBody));
    }

    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;
    return streamResp;
  }

  /**
   * Make a request with automatic x402 payment handling, returning raw JSON.
   * Used for non-ChatResponse endpoints (X/Twitter, search, image edit, etc.).
   */
  private async requestWithPaymentRaw(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const url = `${this.apiUrl}${endpoint}`;

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    });

    // Auto-retry on transient server errors (502/503)
    if (response.status === 502 || response.status === 503) {
      await new Promise(r => setTimeout(r, 1000));
      const retryResp = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify(body),
      });
      if (retryResp.status !== 502 && retryResp.status !== 503) {
        if (retryResp.status === 402) return this.handlePaymentAndRetryRaw(url, body, retryResp);
        if (!retryResp.ok) {
          let errorBody: unknown;
          try { errorBody = await retryResp.json(); } catch { errorBody = { error: "Request failed" }; }
          throw new APIError(`API error: ${retryResp.status}`, retryResp.status, sanitizeErrorResponse(errorBody));
        }
        return retryResp.json() as Promise<Record<string, unknown>>;
      }
    }

    if (response.status === 402) {
      return this.handlePaymentAndRetryRaw(url, body, response);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error: ${response.status}`,
        response.status,
        sanitizeErrorResponse(errorBody)
      );
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Handle 402 response for raw endpoints: parse requirements, sign payment, retry.
   */
  private async handlePaymentAndRetryRaw(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<Record<string, unknown>> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = await response.json() as Record<string, unknown>;
        if (respBody.x402 || respBody.accepts) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch {
        console.debug("Failed to parse payment header from response body");
      }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);

    const extensions = ((paymentRequired as unknown) as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
    const paymentPayload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || url,
          this.apiUrl
        ),
        resourceDescription: details.resource?.description || "BlockRun AI API call",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
        extensions,
      }
    );

    const retryResponse = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body),
    });

    // Auto-retry on transient server errors (502/503) after payment
    if (retryResponse.status === 502 || retryResponse.status === 503) {
      await new Promise(r => setTimeout(r, 1000));
      const retryResp2 = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "PAYMENT-SIGNATURE": paymentPayload,
        },
        body: JSON.stringify(body),
      });
      if (retryResp2.status !== 502 && retryResp2.status !== 503) {
        if (retryResp2.status === 402) throw new PaymentError("Payment was rejected. Check your wallet balance.");
        if (!retryResp2.ok) {
          let errorBody: unknown;
          try { errorBody = await retryResp2.json(); } catch { errorBody = { error: "Request failed" }; }
          throw new APIError(`API error after payment: ${retryResp2.status}`, retryResp2.status, sanitizeErrorResponse(errorBody));
        }
        const costUsd = parseFloat(details.amount) / 1e6;
        this.sessionCalls += 1;
        this.sessionTotalUsd += costUsd;
        this.recordCost(url, costUsd, { body, network: details.network });
        return retryResp2.json() as Promise<Record<string, unknown>>;
      }
    }

    if (retryResponse.status === 402) {
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
    }

    if (!retryResponse.ok) {
      let errorBody: unknown;
      try {
        errorBody = await retryResponse.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error after payment: ${retryResponse.status}`,
        retryResponse.status,
        sanitizeErrorResponse(errorBody)
      );
    }

    const costUsd = parseFloat(details.amount) / 1e6;
    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;
    this.recordCost(url, costUsd, { body, network: details.network });

    return retryResponse.json() as Promise<Record<string, unknown>>;
  }

  /**
   * GET with automatic x402 payment handling, returning raw JSON.
   * Used for Predexon prediction market endpoints that use GET + query params.
   */
  private async getWithPaymentRaw(
    endpoint: string,
    params?: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const query = params ? "?" + new URLSearchParams(params).toString() : "";
    const url = `${this.apiUrl}${endpoint}${query}`;

    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
    });

    // Auto-retry on transient server errors (502/503)
    if (response.status === 502 || response.status === 503) {
      await new Promise(r => setTimeout(r, 1000));
      const retryResp = await this.fetchWithTimeout(url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
      });
      if (retryResp.status !== 502 && retryResp.status !== 503) {
        if (retryResp.status === 402) return this.handleGetPaymentAndRetryRaw(url, endpoint, params, retryResp);
        if (!retryResp.ok) {
          let errorBody: unknown;
          try { errorBody = await retryResp.json(); } catch { errorBody = { error: "Request failed" }; }
          throw new APIError(`API error: ${retryResp.status}`, retryResp.status, sanitizeErrorResponse(errorBody));
        }
        return retryResp.json() as Promise<Record<string, unknown>>;
      }
    }

    if (response.status === 402) {
      return this.handleGetPaymentAndRetryRaw(url, endpoint, params, response);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error: ${response.status}`,
        response.status,
        sanitizeErrorResponse(errorBody)
      );
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Handle 402 response for GET endpoints: parse requirements, sign payment, retry with GET.
   */
  private async handleGetPaymentAndRetryRaw(
    url: string,
    endpoint: string,
    params: Record<string, string> | undefined,
    response: Response
  ): Promise<Record<string, unknown>> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = await response.json() as Record<string, unknown>;
        if (respBody.x402 || respBody.accepts) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch {
        console.debug("Failed to parse payment header from response body");
      }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);

    const extensions = ((paymentRequired as unknown) as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
    const paymentPayload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || url,
          this.apiUrl
        ),
        resourceDescription: details.resource?.description || "BlockRun AI API call",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
        extensions,
      }
    );

    const query = params ? "?" + new URLSearchParams(params).toString() : "";
    const retryUrl = `${this.apiUrl}${endpoint}${query}`;
    const retryResponse = await this.fetchWithTimeout(retryUrl, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        "PAYMENT-SIGNATURE": paymentPayload,
      },
    });

    // Auto-retry on transient server errors (502/503) after payment
    if (retryResponse.status === 502 || retryResponse.status === 503) {
      await new Promise(r => setTimeout(r, 1000));
      const retryResp2 = await this.fetchWithTimeout(retryUrl, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          "PAYMENT-SIGNATURE": paymentPayload,
        },
      });
      if (retryResp2.status !== 502 && retryResp2.status !== 503) {
        if (retryResp2.status === 402) throw new PaymentError("Payment was rejected. Check your wallet balance.");
        if (!retryResp2.ok) {
          let errorBody: unknown;
          try { errorBody = await retryResp2.json(); } catch { errorBody = { error: "Request failed" }; }
          throw new APIError(`API error after payment: ${retryResp2.status}`, retryResp2.status, sanitizeErrorResponse(errorBody));
        }
        const costUsd = parseFloat(details.amount) / 1e6;
        this.sessionCalls += 1;
        this.sessionTotalUsd += costUsd;
        this.recordCost(url, costUsd, { network: details.network });
        return retryResp2.json() as Promise<Record<string, unknown>>;
      }
    }

    if (retryResponse.status === 402) {
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
    }

    if (!retryResponse.ok) {
      let errorBody: unknown;
      try {
        errorBody = await retryResponse.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error after payment: ${retryResponse.status}`,
        retryResponse.status,
        sanitizeErrorResponse(errorBody)
      );
    }

    const costUsd = parseFloat(details.amount) / 1e6;
    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;
    this.recordCost(url, costUsd, { network: details.network });

    return retryResponse.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Fetch with timeout.
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * List available models with pricing.
   *
   * Returns the full `/v1/models` unified catalog (chat + image + music).
   * The shape preserves backwards compatibility — image/music rows have
   * `inputPrice = outputPrice = 0` since those fields don't apply, and
   * their per-call price surfaces via `flatPrice`.
   */
  async listModels(): Promise<Model[]> {
    const raw = await this.fetchRawModels();
    return raw.map((m) => mapRawToModel(m));
  }

  /**
   * List available image generation models with pricing.
   *
   * The dedicated `/v1/images/models` endpoint was deprecated server-side;
   * image models live in the unified `/v1/models` catalog under
   * `categories: ["image", ...]`. This method filters that catalog so
   * existing callers keep working.
   */
  async listImageModels(): Promise<ImageModel[]> {
    const raw = await this.fetchRawModels();
    return raw
      .filter((m) => Array.isArray(m.categories) && m.categories.includes("image"))
      .map((m) => mapRawToImageModel(m));
  }

  /**
   * List all available models (chat, image, music, etc.) with pricing.
   *
   * @returns Array of all models with `type` field set from category
   * (`llm` for chat, `image` / `music` for media). Backwards-compat:
   * chat models always report `type: "llm"`.
   */
  async listAllModels(): Promise<(Model | ImageModel)[]> {
    const raw = await this.fetchRawModels();
    const out: (Model | ImageModel)[] = [];
    for (const m of raw) {
      const cats: string[] = Array.isArray(m.categories) ? m.categories : [];
      if (cats.includes("image")) {
        const model = mapRawToImageModel(m);
        model.type = "image";
        out.push(model);
      } else {
        const model = mapRawToModel(m);
        model.type = "llm";
        out.push(model);
      }
    }
    return out;
  }

  /**
   * Internal: fetch the raw `/v1/models` catalog without normalising shape.
   * Used by listImageModels / listAllModels so each can pick category-
   * specific fields.
   */
  private async fetchRawModels(): Promise<Array<Record<string, unknown> & { categories?: string[] }>> {
    const response = await this.fetchWithTimeout(`${this.apiUrl}/v1/models`, {
      method: "GET",
    });
    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(
        `Failed to list models: ${response.status}`,
        response.status,
        sanitizeErrorResponse(errorBody)
      );
    }
    const data = (await response.json()) as { data?: Array<Record<string, unknown>> };
    return (data.data || []) as Array<Record<string, unknown> & { categories?: string[] }>;
  }

  /**
   * Edit an image using img2img.
   *
   * @param prompt - Text description of the desired edit
   * @param image - Base64-encoded image or URL of the source image
   * @param options - Optional edit parameters
   * @returns ImageResponse with edited image URLs
   */
  async imageEdit(
    prompt: string,
    image: string,
    options?: ImageEditOptions
  ): Promise<ImageResponse> {
    const body: Record<string, unknown> = {
      model: options?.model || "openai/gpt-image-1",
      prompt,
      image,
      size: options?.size || "1024x1024",
      n: options?.n || 1,
    };
    if (options?.mask !== undefined) {
      body.mask = options.mask;
    }
    const data = await this.requestWithPaymentRaw("/v1/images/image2image", body);
    return data as unknown as ImageResponse;
  }

  /**
   * Standalone search (web, X/Twitter, news).
   *
   * @param query - Search query
   * @param options - Optional search parameters
   * @returns SearchResult with summary and citations
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      query,
      max_results: options?.maxResults || 10,
    };
    if (options?.sources !== undefined) body.sources = options.sources;
    if (options?.fromDate !== undefined) body.from_date = options.fromDate;
    if (options?.toDate !== undefined) body.to_date = options.toDate;

    const data = await this.requestWithPaymentRaw("/v1/search", body);
    return data as unknown as SearchResult;
  }

  /**
   * Generic Exa endpoint proxy (POST). Useful when you need an Exa API
   * surface that the typed wrappers below don't expose.
   *
   * @param path - Exa endpoint segment: "search" | "find-similar" | "contents" | "answer"
   * @param body - Request body (see Exa API docs)
   *
   * @example
   * const results = await client.exa("search", { query: "latest AI research", numResults: 5 });
   */
  async exa(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw(`/v1/exa/${path}`, body);
  }

  /**
   * Neural web search via Exa. Returns semantically relevant URLs and metadata.
   * Understands meaning, not just keywords. $0.01/call.
   *
   * @param query - Natural language search query
   * @param options - Optional filters (numResults, category, date range, domains)
   */
  async exaSearch(query: string, options?: ExaSearchOptions): Promise<ExaSearchResponse> {
    const body: Record<string, unknown> = { query };
    if (options?.numResults !== undefined) body.numResults = options.numResults;
    if (options?.category !== undefined) body.category = options.category;
    if (options?.startPublishedDate !== undefined) body.startPublishedDate = options.startPublishedDate;
    if (options?.endPublishedDate !== undefined) body.endPublishedDate = options.endPublishedDate;
    if (options?.includeDomains !== undefined) body.includeDomains = options.includeDomains;
    if (options?.excludeDomains !== undefined) body.excludeDomains = options.excludeDomains;
    const data = await this.requestWithPaymentRaw("/v1/exa/search", body);
    return (data as { data: ExaSearchResponse }).data;
  }

  /**
   * Ask a question and get a cited, synthesized answer grounded in real web sources.
   * No hallucinations — every claim is backed by a citation. $0.01/call.
   *
   * @param query - The question to answer
   */
  async exaAnswer(query: string): Promise<ExaAnswerResponse> {
    const data = await this.requestWithPaymentRaw("/v1/exa/answer", { query });
    return (data as { data: ExaAnswerResponse }).data;
  }

  /**
   * Fetch full Markdown text content from a list of URLs. $0.002 per URL.
   * Returns clean text ready to feed into an LLM context window.
   *
   * @param urls - Array of URLs to fetch (up to 100)
   */
  async exaContents(urls: string[]): Promise<ExaContentsResponse> {
    const data = await this.requestWithPaymentRaw("/v1/exa/contents", { urls });
    return (data as { data: ExaContentsResponse }).data;
  }

  /**
   * Find pages semantically similar to a given URL. $0.01/call.
   * Useful for discovering competitors, alternatives, and related resources.
   *
   * @param url - Reference URL
   * @param options - Optional filters (numResults, excludeSourceDomain)
   */
  async exaFindSimilar(url: string, options?: ExaFindSimilarOptions): Promise<ExaSearchResponse> {
    const body: Record<string, unknown> = { url };
    if (options?.numResults !== undefined) body.numResults = options.numResults;
    if (options?.excludeSourceDomain !== undefined) body.excludeSourceDomain = options.excludeSourceDomain;
    const data = await this.requestWithPaymentRaw("/v1/exa/find-similar", body);
    return (data as { data: ExaSearchResponse }).data;
  }

  /**
   * Get USDC balance on Base mainnet.
   *
   * @returns USDC balance as a float (6 decimal places normalized)
   *
   * @example
   * const balance = await client.getBalance();
   * console.log(`Balance: $${balance.toFixed(2)} USDC`);
   */
  async getBalance(): Promise<number> {
    const usdcContract = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const rpcs = ["https://base.publicnode.com", "https://mainnet.base.org", "https://base.meowrpc.com"];

    const selector = "0x70a08231";
    const paddedAddress = this.account.address.slice(2).toLowerCase().padStart(64, "0");
    const data = selector + paddedAddress;

    const payload = {
      jsonrpc: "2.0",
      method: "eth_call",
      params: [{ to: usdcContract, data }, "latest"],
      id: 1,
    };

    let lastError: unknown;
    for (const rpc of rpcs) {
      try {
        const response = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = (await response.json()) as { result?: string };
        const balanceRaw = parseInt(result.result || "0x0", 16);
        return balanceRaw / 1_000_000;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("All RPCs failed");
  }

  // ============================================================
  // X/Twitter endpoints (powered by AttentionVC)
  // ============================================================

  /**
   * Look up X/Twitter user profiles by username.
   *
   * Powered by AttentionVC. $0.002 per user (min $0.02, max $0.20).
   *
   * @param usernames - Single username or array of usernames (without @)
   */
  async xUserLookup(usernames: string | string[]): Promise<XUserLookupResponse> {
    const names = Array.isArray(usernames) ? usernames : [usernames];
    const data = await this.requestWithPaymentRaw("/v1/x/users/lookup", { usernames: names });
    return data as unknown as XUserLookupResponse;
  }

  /**
   * Get followers of an X/Twitter user.
   *
   * Powered by AttentionVC. $0.05 per page (~200 accounts).
   *
   * @param username - X/Twitter username (without @)
   * @param cursor - Pagination cursor from previous response
   */
  async xFollowers(username: string, cursor?: string): Promise<XFollowersResponse> {
    const body: Record<string, unknown> = { username };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/followers", body);
    return data as unknown as XFollowersResponse;
  }

  /**
   * Get accounts an X/Twitter user is following.
   *
   * Powered by AttentionVC. $0.05 per page (~200 accounts).
   *
   * @param username - X/Twitter username (without @)
   * @param cursor - Pagination cursor from previous response
   */
  async xFollowings(username: string, cursor?: string): Promise<XFollowingsResponse> {
    const body: Record<string, unknown> = { username };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/followings", body);
    return data as unknown as XFollowingsResponse;
  }

  /**
   * Get detailed profile info for a single X/Twitter user.
   *
   * Powered by AttentionVC. $0.002 per request.
   *
   * @param username - X/Twitter username (without @)
   */
  async xUserInfo(username: string): Promise<XUserInfoResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/users/info", { username });
    return data as unknown as XUserInfoResponse;
  }

  /**
   * Get verified (blue-check) followers of an X/Twitter user.
   *
   * Powered by AttentionVC. $0.048 per page.
   *
   * @param userId - X/Twitter user ID (not username)
   * @param cursor - Pagination cursor from previous response
   */
  async xVerifiedFollowers(userId: string, cursor?: string): Promise<XVerifiedFollowersResponse> {
    const body: Record<string, unknown> = { userId };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/verified-followers", body);
    return data as unknown as XVerifiedFollowersResponse;
  }

  /**
   * Get tweets posted by an X/Twitter user.
   *
   * Powered by AttentionVC. $0.032 per page.
   *
   * @param username - X/Twitter username (without @)
   * @param includeReplies - Include reply tweets (default: false)
   * @param cursor - Pagination cursor from previous response
   */
  async xUserTweets(
    username: string,
    includeReplies = false,
    cursor?: string
  ): Promise<XTweetsResponse> {
    const body: Record<string, unknown> = { username, includeReplies };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/tweets", body);
    return data as unknown as XTweetsResponse;
  }

  /**
   * Get tweets that mention an X/Twitter user.
   *
   * Powered by AttentionVC. $0.032 per page.
   *
   * @param username - X/Twitter username (without @)
   * @param sinceTime - Start time filter (ISO8601 or Unix timestamp)
   * @param untilTime - End time filter (ISO8601 or Unix timestamp)
   * @param cursor - Pagination cursor from previous response
   */
  async xUserMentions(
    username: string,
    sinceTime?: string,
    untilTime?: string,
    cursor?: string
  ): Promise<XMentionsResponse> {
    const body: Record<string, unknown> = { username };
    if (sinceTime !== undefined) body.sinceTime = sinceTime;
    if (untilTime !== undefined) body.untilTime = untilTime;
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/mentions", body);
    return data as unknown as XMentionsResponse;
  }

  /**
   * Fetch full tweet data for up to 200 tweet IDs.
   *
   * Powered by AttentionVC. $0.16 per batch.
   *
   * @param tweetIds - Single tweet ID or array of tweet IDs (max 200)
   */
  async xTweetLookup(tweetIds: string | string[]): Promise<XTweetLookupResponse> {
    const ids = Array.isArray(tweetIds) ? tweetIds : [tweetIds];
    const data = await this.requestWithPaymentRaw("/v1/x/tweets/lookup", { tweet_ids: ids });
    return data as unknown as XTweetLookupResponse;
  }

  /**
   * Get replies to a specific tweet.
   *
   * Powered by AttentionVC. $0.032 per page.
   *
   * @param tweetId - The tweet ID to get replies for
   * @param queryType - Sort order: 'Latest' or 'Default'
   * @param cursor - Pagination cursor from previous response
   */
  async xTweetReplies(
    tweetId: string,
    queryType = "Latest",
    cursor?: string
  ): Promise<XTweetRepliesResponse> {
    const body: Record<string, unknown> = { tweetId, queryType };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/tweets/replies", body);
    return data as unknown as XTweetRepliesResponse;
  }

  /**
   * Get the full thread context for a tweet.
   *
   * Powered by AttentionVC. $0.032 per page.
   *
   * @param tweetId - The tweet ID to get thread for
   * @param cursor - Pagination cursor from previous response
   */
  async xTweetThread(tweetId: string, cursor?: string): Promise<XTweetThreadResponse> {
    const body: Record<string, unknown> = { tweetId };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/tweets/thread", body);
    return data as unknown as XTweetThreadResponse;
  }

  /**
   * Search X/Twitter with advanced query operators.
   *
   * Powered by AttentionVC. $0.032 per page.
   *
   * @param query - Search query (supports Twitter search operators)
   * @param queryType - Sort order: 'Latest', 'Top', or 'Default'
   * @param cursor - Pagination cursor from previous response
   */
  async xSearch(
    query: string,
    queryType = "Latest",
    cursor?: string
  ): Promise<XSearchResponse> {
    const body: Record<string, unknown> = { query, queryType };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/search", body);
    return data as unknown as XSearchResponse;
  }

  /**
   * Get current trending topics on X/Twitter.
   *
   * Powered by AttentionVC. $0.002 per request.
   */
  async xTrending(): Promise<XTrendingResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/trending", {});
    return data as unknown as XTrendingResponse;
  }

  /**
   * Get rising/viral articles from X/Twitter.
   *
   * Powered by AttentionVC intelligence layer. $0.05 per request.
   */
  async xArticlesRising(): Promise<XArticlesRisingResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/articles/rising", {});
    return data as unknown as XArticlesRisingResponse;
  }

  /**
   * Get author analytics and intelligence metrics for an X/Twitter user.
   *
   * Powered by AttentionVC intelligence layer. $0.02 per request.
   *
   * @param handle - X/Twitter handle (without @)
   */
  async xAuthorAnalytics(handle: string): Promise<XAuthorAnalyticsResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/authors", { handle });
    return data as unknown as XAuthorAnalyticsResponse;
  }

  /**
   * Compare two X/Twitter authors side-by-side with intelligence metrics.
   *
   * Powered by AttentionVC intelligence layer. $0.05 per request.
   *
   * @param handle1 - First X/Twitter handle (without @)
   * @param handle2 - Second X/Twitter handle (without @)
   */
  async xCompareAuthors(handle1: string, handle2: string): Promise<XCompareAuthorsResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/compare", { handle1, handle2 });
    return data as unknown as XCompareAuthorsResponse;
  }

  // ── Prediction Markets (Powered by Predexon) ────────────────────────────

  /**
   * Query Predexon prediction market data (GET endpoints).
   *
   * Access real-time data from Polymarket, Kalshi, dFlow, and Binance Futures.
   * Powered by Predexon. $0.001 per request.
   *
   * @param path - Endpoint path, e.g. "polymarket/events", "kalshi/markets/12345"
   * @param params - Query parameters passed to the endpoint
   *
   * @example
   * const events = await client.pm("polymarket/events");
   * const market = await client.pm("kalshi/markets/KXBTC-25MAR14");
   * const results = await client.pm("polymarket/search", { q: "bitcoin" });
   */
  async pm(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.getWithPaymentRaw(`/v1/pm/${path}`, params);
  }

  /**
   * Structured query for Predexon prediction market data (POST endpoints).
   *
   * For endpoints that require a JSON body, e.g. bulk wallet identity lookup.
   * Tier 1 = $0.001/call, Tier 2 = $0.005/call.
   *
   * @param path - Endpoint path, e.g. "polymarket/wallet/identities"
   * @param query - JSON body for the structured query
   *
   * @example
   * const batch = await client.pmQuery("polymarket/wallet/identities", {
   *   addresses: ["0xabc...", "0xdef..."],
   * });
   */
  async pmQuery(path: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw(`/v1/pm/${path}`, query);
  }

  // ── PM convenience helpers (Predexon v2) ─────────────────────────────────
  // Thin wrappers over pm() / pmQuery() for the most common v2 endpoints.

  /** List canonical cross-venue markets (Predexon v2). Tier 1 ($0.001/call).
   * Filter with venue, status, category, league, event_id, pagination_key. */
  async pmMarkets(params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.pm("markets", params);
  }

  /** List venue-native executable listings flattened across canonical markets
   * (Predexon v2). Tier 1 ($0.001/call). */
  async pmListings(params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.pm("markets/listings", params);
  }

  /** Resolve a canonical Predexon outcome ID to its market context and venue
   * listings. Tier 1 ($0.001/call). */
  async pmOutcome(predexonId: string): Promise<Record<string, unknown>> {
    return this.pm(`outcomes/${predexonId}`);
  }

  /** Polymarket markets with cursor-based keyset pagination (use pagination_key).
   * Tier 1 ($0.001/call). */
  async pmPolymarketMarketsKeyset(params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.pm("polymarket/markets/keyset", params);
  }

  /** Polymarket events with cursor-based keyset pagination (use pagination_key).
   * Tier 1 ($0.001/call). */
  async pmPolymarketEventsKeyset(params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.pm("polymarket/events/keyset", params);
  }

  /** List available sports categories. Tier 1 ($0.001/call). */
  async pmSportsCategories(): Promise<Record<string, unknown>> {
    return this.pm("sports/categories");
  }

  /** List sports markets grouped by game. Filter with league, sport_type,
   * status, venue. Tier 1 ($0.001/call). */
  async pmSportsMarkets(params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.pm("sports/markets", params);
  }

  /** Fetch identity + profile metadata for one wallet (ENS, Twitter, portfolio,
   * etc.). Tier 2 ($0.005/call). */
  async pmWalletIdentity(wallet: string): Promise<Record<string, unknown>> {
    return this.pm(`polymarket/wallet/identity/${wallet}`);
  }

  /** Bulk identity lookup for up to 200 wallet addresses (POST). Tier 2 ($0.005/call). */
  async pmWalletIdentities(addresses: string[]): Promise<Record<string, unknown>> {
    return this.pmQuery("polymarket/wallet/identities", { addresses });
  }

  /** Discover wallets connected to a seed address via on-chain transfers and
   * identity proofs. Tier 2 ($0.005/call). */
  async pmWalletCluster(address: string): Promise<Record<string, unknown>> {
    return this.pm(`polymarket/wallet/${address}/cluster`);
  }

  /**
   * Get current session spending.
   *
   * @returns Object with totalUsd and calls count
   *
   * @example
   * const spending = client.getSpending();
   * console.log(`Spent $${spending.totalUsd.toFixed(4)} across ${spending.calls} calls`);
   */
  getSpending(): Spending {
    return {
      totalUsd: this.sessionTotalUsd,
      calls: this.sessionCalls,
    };
  }

  /**
   * Get the wallet address being used for payments.
   */
  getWalletAddress(): string {
    return this.account.address;
  }

}

export default LLMClient;
