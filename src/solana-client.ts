import { resolveApiKeyAuth, requireWallet, type ApiKeyAuth, type ApiKeyOptions } from "./api-key.js";
/**
 * BlockRun Solana LLM Client.
 *
 * Usage:
 *   import { SolanaLLMClient } from '@blockrun/llm';
 *
 *   // SOLANA_WALLET_KEY env var (bs58-encoded Solana secret key)
 *   const client = new SolanaLLMClient();
 *
 *   // Or pass key directly
 *   const client = new SolanaLLMClient({ privateKey: 'your-bs58-key' });
 *
 *   const response = await client.chat('openai/gpt-5.2', 'gm Solana');
 */
import type {
  ChatMessage,
  ChatResponse,
  ChatOptions,
  ChatCompletionOptions,
  Model,
  RoutingDecision,
  SmartChatCompletionOptions,
  SmartChatCompletionResponse,
  SmartChatOptions,
  SmartChatResponse,
  ImageResponse,
  ImageEditOptions,
  Spending,
  SearchResult,
  SearchOptions,
} from "./types";
import { APIError, PaymentError } from "./types";
import {
  SOLANA_MINIMUM_PAYMENT_USD,
  errSummary,
  isTransientError,
  routeWithCatalog,
  routingProfileForModel,
  routingText,
  type ModelPricing,
} from "./router-adapter";
import {
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  SOLANA_NETWORK,
} from "./x402";
import { solanaKeyToBytes, solanaPublicKey } from "./solana-wallet";
import {
  sanitizeErrorResponse,
  validateApiUrl,
  validateMaxTokens,
  validateResourceUrl,
} from "./validation";
import { USER_AGENT } from "./version";

const SOLANA_API_URL = "https://sol.blockrun.ai/api";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT = 60000;
const STALE_BLOCKHASH_RETRY_BACKOFFS_MS = [500, 2000] as const;
const MAX_PAYMENT_FAILURE_BYTES = 64 * 1024;

class SafeStaleBlockhashError extends PaymentError {
  constructor() {
    super("Payment verification used an expired Solana blockhash; retrying with a fresh quote.");
    this.name = "SafeStaleBlockhashError";
  }
}

function normalizePaymentSignal(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[_\-\s:]/g, "")
    : "";
}

async function readPaymentFailureBody(response: Response): Promise<string | null> {
  // The paid 402 is terminal or converted into an internal retry signal; it is
  // never returned to callers, so consume the original body. Cloning would tee
  // the stream, and cancelling one oversized tee branch can wait forever for
  // the unread sibling branch.
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      total += value.byteLength;
      if (total > MAX_PAYMENT_FAILURE_BYTES) {
        void reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  }
}

/**
 * Recognize only explicitly verification-phase stale-blockhash failures.
 * Settlement may already have broadcast a transaction, so any settlement or
 * phase-ambiguous 402 is terminal even when it mentions blockhash expiry.
 * @internal Exported for the payment safety regression tests.
 */
export async function isSafeStaleBlockhashResponse(response: Response): Promise<boolean> {
  const length = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > MAX_PAYMENT_FAILURE_BYTES) return false;

  const text = await readPaymentFailureBody(response);
  if (text === null) return false;

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    body = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  const nested = body.error && typeof body.error === "object" && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : undefined;
  const errorLabel = typeof body.error === "string" ? body.error : "";
  const code = normalizePaymentSignal(body.code ?? nested?.code);
  const reason = normalizePaymentSignal(body.reason);
  const detail = normalizePaymentSignal(body.invalidMessage);
  const message = normalizePaymentSignal(nested?.message ?? body.message);
  const label = normalizePaymentSignal(errorLabel);

  if (
    code.includes("settlementfailed") ||
    label.includes("settlementfailed") ||
    message.includes("settlementfailed")
  ) return false;

  const verifyPhase =
    code === "paymentinvalid" ||
    label.includes("verificationfailed") ||
    message.includes("verificationfailed");
  if (!verifyPhase) return false;

  return (
    code === "paymentblockhashstale" ||
    detail.includes("blockhashnotfound") ||
    detail.includes("blockheightexceeded") ||
    reason === "expiredsignature" ||
    message.includes("expiredsignature")
  );
}

async function waitForStaleRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, STALE_BLOCKHASH_RETRY_BACKOFFS_MS[attempt])
  );
}

/**
 * Default Solana RPC URL — BlockRun's multi-region Tatum-backed JSON-RPC
 * proxy. Free for SDK users (bundled into LLM inference fees you already
 * pay) with method-aware server-side caching (`getLatestBlockhash` at 30s
 * TTL) that collapses bursty signing traffic to a handful of upstream RPC
 * calls. Public `api.mainnet-beta.solana.com` remains reachable via
 * explicit config, but its ~10–40 RPS limit is too aggressive for any
 * real concurrency. Override with `rpcUrl` / `SOLANA_RPC_URL` to bypass.
 */
const DEFAULT_SOLANA_RPC_URL = "https://sol.blockrun.ai/api/v1/solana/rpc";

export interface SolanaLLMClientOptions extends ApiKeyOptions {
  /** bs58-encoded Solana secret key (64 bytes). Optional if SOLANA_WALLET_KEY env var is set. */
  privateKey?: string;
  /** API endpoint URL (default: https://sol.blockrun.ai/api) */
  apiUrl?: string;
  /**
   * Solana JSON-RPC URL. Defaults to BlockRun's own Tatum-backed proxy
   * (`https://sol.blockrun.ai/api/v1/solana/rpc`), free for SDK users.
   * Override to point at your own Helius / Tatum / QuickNode account, or
   * fall back to the env vars `SOLANA_RPC_URL` /
   * `SOLANA_RPC_API_KEY` / `SOLANA_RPC_HEADERS`.
   */
  rpcUrl?: string;
  /**
   * Optional headers forwarded to the Solana RPC endpoint. Use this for
   * header-auth gateways (Tatum's `x-api-key`, some Triton tiers). Falls
   * back to `SOLANA_RPC_HEADERS` (JSON dict) or `SOLANA_RPC_API_KEY`
   * (shortcut for `{ "x-api-key": "..." }`) env vars when omitted.
   */
  rpcHeaders?: Record<string, string>;
  /** Request timeout in milliseconds (default: 60000) */
  timeout?: number;
}

/**
 * Resolve the effective Solana RPC URL + headers from explicit args, env
 * vars, or defaults — in that priority order. Mirrors the Python SDK's
 * `_resolve_rpc_config` (see blockrun-llm 0.23.0 / 0.24.0).
 */
function resolveRpcConfig(
  rpcUrl: string | undefined,
  rpcHeaders: Record<string, string> | undefined
): { url: string; headers?: Record<string, string> } {
  const env =
    typeof process !== "undefined" && process.env ? process.env : ({} as NodeJS.ProcessEnv);

  const url = rpcUrl || env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC_URL;

  let headers: Record<string, string> | undefined;
  if (rpcHeaders) {
    headers = { ...rpcHeaders };
  } else if (env.SOLANA_RPC_HEADERS) {
    try {
      const parsed = JSON.parse(env.SOLANA_RPC_HEADERS);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        headers = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [String(k), String(v)])
        );
      }
    } catch {
      /* ignore malformed env var */
    }
  } else if (env.SOLANA_RPC_API_KEY) {
    headers = { "x-api-key": env.SOLANA_RPC_API_KEY };
  }

  return headers ? { url, headers } : { url };
}

export class SolanaLLMClient {
  static readonly SOLANA_API_URL = SOLANA_API_URL;

  private apiAuth?: ApiKeyAuth;
  get authMode(): "api-key" | "wallet" { return this.apiAuth ? "api-key" : "wallet"; }
  private _privateKey?: string;
  private get privateKey(): string { return requireWallet(this._privateKey); }
  private apiUrl: string;
  private rpcUrl: string;
  private rpcHeaders?: Record<string, string>;
  private timeout: number;
  private sessionTotalUsd = 0;
  private sessionCalls = 0;
  private addressCache: string | null = null;
  private modelPricingCache: Map<string, ModelPricing> | null = null;
  private modelPricingPromise: Promise<Map<string, ModelPricing>> | null = null;

  constructor(options: SolanaLLMClientOptions = {}) {
    this.apiAuth = resolveApiKeyAuth(options);
    if (!this.apiAuth) {
      const envKey = typeof process !== "undefined" && process.env
        ? process.env.SOLANA_WALLET_KEY
        : undefined;
      const privateKey = options.privateKey || envKey;

      if (!privateKey) {
        throw new Error(
          "Private key required. Pass privateKey in options or set SOLANA_WALLET_KEY environment variable."
        );
      }

      this._privateKey = privateKey;

    }
    const apiUrl = this.apiAuth?.apiUrl || options.apiUrl || SOLANA_API_URL;
    validateApiUrl(apiUrl);
    this.apiUrl = apiUrl.replace(/\/$/, "");

    const rpc = resolveRpcConfig(options.rpcUrl, options.rpcHeaders);
    this.rpcUrl = rpc.url;
    this.rpcHeaders = rpc.headers;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  /** Get Solana wallet address (public key in base58). */
  async getWalletAddress(): Promise<string> {
    if (!this.addressCache) {
      this.addressCache = await solanaPublicKey(this.privateKey);
    }
    return this.addressCache;
  }

  /** Simple 1-line chat. */
  async chat(model: string, prompt: string, options?: ChatOptions): Promise<string> {
    const messages: ChatMessage[] = [];
    if (options?.system) messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: prompt });
    const result = await this.chatCompletion(model, messages, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      topP: options?.topP,
      search: options?.search,
      searchParameters: options?.searchParameters,
      responseFormat: options?.responseFormat,
      stop: options?.stop,
      fallbackModels: options?.fallbackModels,
    });
    return result.choices[0].message.content || "";
  }

  /** Full chat completion (OpenAI-compatible). */
  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    options?: ChatCompletionOptions
  ): Promise<ChatResponse> {
    const routingProfile = routingProfileForModel(model);
    if (routingProfile) {
      return (
        await this.smartChatCompletion(messages, {
          ...options,
          routingProfile,
        })
      ).response;
    }
    validateMaxTokens(options?.maxTokens);

    const buildBody = (candidate: string): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: candidate,
        messages,
        max_tokens: options?.maxTokens || DEFAULT_MAX_TOKENS,
      };
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.topP !== undefined) body.top_p = options.topP;
      if (options?.searchParameters !== undefined) body.search_parameters = options.searchParameters;
      else if (options?.search === true) body.search_parameters = { mode: "on" };
      if (options?.tools !== undefined) body.tools = options.tools;
      if (options?.toolChoice !== undefined) body.tool_choice = options.toolChoice;
      if (options?.responseFormat !== undefined) body.response_format = options.responseFormat;
      if (options?.stop !== undefined) body.stop = options.stop;
      return body;
    };
    const chain = [model, ...(options?.fallbackModels ?? [])];
    let lastError: unknown;
    for (let index = 0; index < chain.length; index += 1) {
      const candidate = chain[index];
      try {
        return await this.requestWithPayment("/v1/chat/completions", buildBody(candidate));
      } catch (error) {
        lastError = error;
        if (!isTransientError(error) || index === chain.length - 1) throw error;
        // Same one-line hop visibility the Base client provides — a paid
        // request must never switch models silently.
        console.error(`[@blockrun/llm] ${candidate} -> ${chain[index + 1]} (${errSummary(error)})`);
      }
    }
    throw lastError;
  }

  private async getModelPricing(): Promise<Map<string, ModelPricing>> {
    if (this.modelPricingCache) return this.modelPricingCache;
    if (this.modelPricingPromise) return this.modelPricingPromise;
    this.modelPricingPromise = (async () => {
      const models = await this.listModels();
      const pricing = new Map<string, ModelPricing>();
      for (const model of models) {
        const raw = model as Model & {
          input_price?: number;
          output_price?: number;
          flat_price?: number;
          billing_mode?: string;
          pricing?: { input?: number; output?: number; flat?: number };
        };
        // Skip catalog rows marked unavailable, and guard against malformed
        // values: Number("abc") is NaN, which survives `?? 0` and would
        // silently poison route scoring and cost metadata downstream.
        if (model.available === false) continue;
        const num = (value: unknown): number => {
          const n = Number(value ?? 0);
          return Number.isFinite(n) ? n : 0;
        };
        const inputPrice = num(model.inputPrice ?? raw.input_price ?? raw.pricing?.input);
        const outputPrice = num(model.outputPrice ?? raw.output_price ?? raw.pricing?.output);
        const flatPrice = num(model.flatPrice ?? raw.flat_price ?? raw.pricing?.flat);
        pricing.set(model.id, {
          inputPrice,
          outputPrice,
          ...((model.billingMode ?? raw.billing_mode) === "flat" && flatPrice > 0
            ? { flatPrice }
            : {}),
        });
      }
      return pricing;
    })();
    try {
      this.modelPricingCache = await this.modelPricingPromise;
      return this.modelPricingCache;
    } finally {
      this.modelPricingPromise = null;
    }
  }

  /** Inspect a Solana route without making or paying for a model call. */
  async route(prompt: string, options?: SmartChatOptions): Promise<RoutingDecision> {
    return routeWithCatalog(
      prompt,
      options?.system,
      options?.maxOutputTokens ?? options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      await this.getModelPricing(),
      {
        routingProfile: options?.routingProfile,
        requiresStructuredOutput: options?.responseFormat !== undefined,
        minimumPaymentUsd: this.apiAuth ? 0 : SOLANA_MINIMUM_PAYMENT_USD,
      },
    );
  }

  /** Smart one-line chat paid on Solana. */
  async smartChat(prompt: string, options?: SmartChatOptions): Promise<SmartChatResponse> {
    const decision = await this.route(prompt, options);
    const response = await this.chat(decision.model, prompt, {
      ...options,
      // An explicit caller-supplied chain wins over the routed one.
      fallbackModels: options?.fallbackModels ?? decision.fallbacks,
    });
    return { response, model: decision.model, routing: decision };
  }

  /** Smart full message/tool completion paid on Solana. */
  async smartChatCompletion(
    messages: ChatMessage[],
    options: SmartChatCompletionOptions = {},
  ): Promise<SmartChatCompletionResponse> {
    const { prompt, systemPrompt, conversationChars, hasVision } = routingText(messages);
    const decision = routeWithCatalog(
      prompt,
      systemPrompt,
      options.maxOutputTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS,
      await this.getModelPricing(),
      {
        routingProfile: options.routingProfile,
        requiresStructuredOutput: options.responseFormat !== undefined,
        tools: options.tools,
        toolChoice: options.toolChoice,
        conversationChars,
        hasVision,
        minimumPaymentUsd: this.apiAuth ? 0 : SOLANA_MINIMUM_PAYMENT_USD,
      },
    );
    const response = await this.chatCompletion(decision.model, messages, {
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      search: options.search,
      searchParameters: options.searchParameters,
      tools: options.tools,
      toolChoice: options.toolChoice,
      responseFormat: options.responseFormat,
      stop: options.stop,
      // An explicit caller-supplied chain wins over the routed one.
      fallbackModels: options.fallbackModels ?? decision.fallbacks,
    });
    response.routing = decision;
    return { response, model: decision.model, routing: decision };
  }

  /** List available models. */
  async listModels(): Promise<Model[]> {
    const response = await this.fetchWithTimeout(`${this.apiUrl}/v1/models`, { method: "GET" });
    if (!response.ok) {
      throw new APIError(`Failed to list models: ${response.status}`, response.status);
    }
    const data = (await response.json()) as { data?: Model[] };
    return data.data || [];
  }

  /**
   * Get Solana USDC balance.
   *
   * @returns USDC balance as a float
   */
  async getBalance(): Promise<number> {
    const usdc_mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const address = await this.getWalletAddress();

    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.rpcHeaders ?? {}) },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [address, { mint: usdc_mint }, { encoding: "jsonParsed" }],
        }),
      });
      const data = (await response.json()) as { result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }> } };
      const accounts = data.result?.value || [];
      if (!accounts.length) return 0;
      let total = 0;
      for (const acct of accounts) {
        total += acct.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      }
      return total;
    } catch {
      return 0;
    }
  }

  /** Edit an image using img2img (Solana payment). */
  async imageEdit(
    prompt: string,
    image: string | string[],
    options?: ImageEditOptions
  ): Promise<ImageResponse> {
    const body: Record<string, unknown> = {
      model: options?.model || "openai/gpt-image-2",
      prompt,
      image,
      size: options?.size || "1024x1024",
      n: options?.n || 1,
    };
    if (options?.mask !== undefined) body.mask = options.mask;
    const data = await this.requestWithPaymentRaw("/v1/images/image2image", body);
    return data as unknown as ImageResponse;
  }

  /** Standalone search (Solana payment). */
  async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    const body: Record<string, unknown> = { query, max_results: options?.maxResults || 10 };
    if (options?.sources !== undefined) body.sources = options.sources;
    if (options?.fromDate !== undefined) body.from_date = options.fromDate;
    if (options?.toDate !== undefined) body.to_date = options.toDate;
    const data = await this.requestWithPaymentRaw("/v1/search", body);
    return data as unknown as SearchResult;
  }

  // ── Prediction Markets (Powered by Predexon) ────────────────────────────

  async pm(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.getWithPaymentRaw(`/v1/pm/${path}`, params);
  }

  async pmQuery(path: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw(`/v1/pm/${path}`, query);
  }

  // ── Exa Web Search (Powered by Exa) ──────────────────────────────────────

  /**
   * Generic Exa endpoint proxy (POST, Solana payment). Powered by Exa.
   *
   * @param path - Exa endpoint: "search" | "find-similar" | "contents" | "answer"
   * @param body - Request body (see Exa API docs)
   *
   * @example
   * const results = await client.exa("search", { query: "latest AI research", numResults: 5 });
   */
  async exa(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw(`/v1/exa/${path}`, body);
  }

  /**
   * Neural and keyword web search via Exa (Solana payment).
   *
   * @example
   * const results = await client.exaSearch("latest AI papers", { numResults: 5 });
   */
  async exaSearch(query: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw("/v1/exa/search", { query, ...options });
  }

  /**
   * Find pages semantically similar to a given URL via Exa (Solana payment).
   *
   * @example
   * const results = await client.exaFindSimilar("https://openai.com/research/gpt-4", { numResults: 5 });
   */
  async exaFindSimilar(url: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw("/v1/exa/find-similar", { url, ...options });
  }

  /**
   * Extract full text content from URLs via Exa (Solana payment).
   *
   * @example
   * const data = await client.exaContents(["https://arxiv.org/abs/2303.08774"]);
   */
  async exaContents(urls: string[], options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw("/v1/exa/contents", { urls, ...options });
  }

  /**
   * AI-generated answer grounded in live web search via Exa (Solana payment).
   *
   * @example
   * const answer = await client.exaAnswer("What is the current state of AI safety research?");
   */
  async exaAnswer(query: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw("/v1/exa/answer", { query, ...options });
  }

  // ============================================================
  // DefiLlama (DeFi protocols / TVL / yields / prices)
  // ============================================================

  /**
   * Query DefiLlama DeFi data (GET passthrough). Powered by DefiLlama.
   * for protocols / protocol/{slug} / chains / yields;
   * for prices/{coins}.
   *
   * @param path - e.g. "protocols", "protocol/aave", "chains", "yields",
   *               "prices/coingecko:bitcoin,base:0x..."
   * @param params - Query parameters passed through to DefiLlama
   */
  async defi(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.getWithPaymentRaw(`/v1/defillama/${path}`, params);
  }

  /** All DeFi protocols with TVL. */
  async defiProtocols(): Promise<Record<string, unknown>> {
    return this.defi("protocols");
  }

  /** Single protocol details + historical TVL. */
  async defiProtocol(slug: string): Promise<Record<string, unknown>> {
    return this.defi(`protocol/${slug}`);
  }

  /** Current TVL of every chain. */
  async defiChains(): Promise<Record<string, unknown>> {
    return this.defi("chains");
  }

  /** Yield pools with APY/TVL. */
  async defiYields(params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.defi("yields", params);
  }

  /** Token price lookup. Coins like "coingecko:bitcoin" or "{chain}:{address}". */
  async defiPrices(coins: string | string[]): Promise<Record<string, unknown>> {
    const joined = Array.isArray(coins) ? coins.join(",") : coins;
    return this.defi(`prices/${joined}`);
  }

  // ============================================================
  // 0x DEX (swap quotes + gasless) — free passthrough
  // ============================================================

  /**
   * Query the 0x Swap / Gasless APIs (free — no x402 payment; BlockRun
   * takes an on-chain affiliate fee on executed swaps instead).
   *
   * @param path - "price", "quote", "gasless/price", "gasless/quote",
   *               "gasless/submit" (POST), "gasless/status/{hash}",
   *               "gasless/approval-tokens", "gasless/chains", "swap/chains"
   * @param params - Query params (chainId, sellToken, buyToken, sellAmount, taker, ...)
   * @param body - JSON body — pass to switch to POST (gasless/submit only)
   */
  async dex(
    path: string,
    params?: Record<string, string>,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (body) return this.requestWithPaymentRaw(`/v1/zerox/${path}`, body);
    return this.getWithPaymentRaw(`/v1/zerox/${path}`, params);
  }

  /** Indicative Permit2 swap price — no commitment (free). */
  async dexPrice(params: Record<string, string>): Promise<Record<string, unknown>> {
    return this.dex("price", params);
  }

  /** Firm Permit2 swap quote with permit2.eip712 + tx data (free). */
  async dexQuote(params: Record<string, string>): Promise<Record<string, unknown>> {
    return this.dex("quote", params);
  }

  /** Gasless indicative price quote (free). */
  async dexGaslessPrice(params: Record<string, string>): Promise<Record<string, unknown>> {
    return this.dex("gasless/price", params);
  }

  /** Gasless firm quote — returns trade.eip712 to sign (free). */
  async dexGaslessQuote(params: Record<string, string>): Promise<Record<string, unknown>> {
    return this.dex("gasless/quote", params);
  }

  /** Submit a signed gasless trade; the 0x relayer pays gas (free). */
  async dexGaslessSubmit(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.dex("gasless/submit", undefined, body);
  }

  /** Poll a gasless trade's status by tradeHash (free). */
  async dexGaslessStatus(tradeHash: string): Promise<Record<string, unknown>> {
    return this.dex(`gasless/status/${tradeHash}`);
  }

  /** Chains where the Swap API is supported (free). */
  async dexChains(): Promise<Record<string, unknown>> {
    return this.dex("swap/chains");
  }

  /** Chains where the Gasless API is supported (free). */
  async dexGaslessChains(): Promise<Record<string, unknown>> {
    return this.dex("gasless/chains");
  }

  // ============================================================
  // Modal Sandbox (pay-per-call cloud compute)
  // ============================================================

  /**
   * Call the Modal sandbox compute API (POST passthrough).
   *
   * @param path - "sandbox/create" (CPU / GPU tiers), "sandbox/exec",
   *               "sandbox/status", "sandbox/terminate"
   * @param body - JSON body for the endpoint
   */
  async modal(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw(`/v1/modal/${path}`, body ?? {});
  }

  /** Create a sandboxed compute environment (CPU / GPU tiers). */
  async modalSandboxCreate(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.modal("sandbox/create", body);
  }

  /** Execute a command in a sandbox; returns stdout/stderr. */
  async modalSandboxExec(
    sandboxId: string,
    command: string[],
    extra?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.modal("sandbox/exec", { sandbox_id: sandboxId, command, ...extra });
  }

  /** Check a sandbox's status. */
  async modalSandboxStatus(sandboxId: string): Promise<Record<string, unknown>> {
    return this.modal("sandbox/status", { sandbox_id: sandboxId });
  }

  /** Terminate a sandbox. */
  async modalSandboxTerminate(sandboxId: string): Promise<Record<string, unknown>> {
    return this.modal("sandbox/terminate", { sandbox_id: sandboxId });
  }

  /** Get session spending. */
  getSpending(): Spending {
    if (this.apiAuth) throw new Error("Account usage is available at https://user.blockrun.ai/dashboard; getSpending() tracks x402 settlements only.");
    return { totalUsd: this.sessionTotalUsd, calls: this.sessionCalls };
  }

  /** True if using sol.blockrun.ai. */
  isSolana(): boolean {
    return this.apiUrl.includes("sol.blockrun.ai");
  }

  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<ChatResponse> {
    const url = `${this.apiUrl}${endpoint}`;
    for (let staleRetries = 0; ; ) {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify(body),
      });

      if (response.status === 402) {
        try {
          return await this.handlePaymentAndRetry(url, body, response, staleRetries > 0);
        } catch (error) {
          if (
            !(error instanceof SafeStaleBlockhashError) ||
            staleRetries >= STALE_BLOCKHASH_RETRY_BACKOFFS_MS.length
          ) throw error;
          await waitForStaleRetry(staleRetries++);
          continue;
        }
      }

      if (!response.ok) {
        let errorBody: unknown;
        try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
        throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
      }

      return response.json() as Promise<ChatResponse>;
    }
  }

  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response,
    forceFreshBlockhash = false
  ): Promise<ChatResponse> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = await response.json() as Record<string, unknown>;
        if (respBody.accepts || respBody.x402Version) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch { /* ignore */ }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);

    if (!details.network?.startsWith("solana:")) {
      throw new PaymentError(
        `Expected Solana payment network, got: ${details.network}. Use LLMClient for Base payments.`
      );
    }

    const feePayer = (details.extra as { feePayer?: string })?.feePayer;
    if (!feePayer) throw new PaymentError("Missing feePayer in 402 extra field");

    const fromAddress = await this.getWalletAddress();
    const secretKey = await solanaKeyToBytes(this.privateKey);
    const extensions = ((paymentRequired as unknown) as Record<string, unknown>).extensions as Record<string, unknown> | undefined;

    const paymentPayload = await createSolanaPaymentPayload(
      secretKey,
      fromAddress,
      details.recipient,
      details.amount,
      feePayer,
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || `${this.apiUrl}/v1/chat/completions`,
          this.apiUrl
        ),
        resourceDescription: details.resource?.description || "BlockRun Solana AI API call",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown>,
        extensions,
        rpcUrl: this.rpcUrl,
        rpcHeaders: this.rpcHeaders,
        forceFreshBlockhash,
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

    if (retryResponse.status === 402) {
      if (await isSafeStaleBlockhashResponse(retryResponse)) {
        throw new SafeStaleBlockhashError();
      }
      throw new PaymentError("Payment was rejected. Check your Solana USDC balance.");
    }

    if (!retryResponse.ok) {
      let errorBody: unknown;
      try { errorBody = await retryResponse.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error after payment: ${retryResponse.status}`, retryResponse.status, sanitizeErrorResponse(errorBody));
    }

    const costUsd = parseFloat(details.amount) / 1e6;
    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;

    return retryResponse.json() as Promise<ChatResponse>;
  }

  private async requestWithPaymentRaw(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const url = `${this.apiUrl}${endpoint}`;
    for (let staleRetries = 0; ; ) {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify(body),
      });

      if (response.status === 402) {
        try {
          return await this.handlePaymentAndRetryRaw(url, body, response, staleRetries > 0);
        } catch (error) {
          if (
            !(error instanceof SafeStaleBlockhashError) ||
            staleRetries >= STALE_BLOCKHASH_RETRY_BACKOFFS_MS.length
          ) throw error;
          await waitForStaleRetry(staleRetries++);
          continue;
        }
      }

      if (!response.ok) {
        let errorBody: unknown;
        try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
        throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
      }

      if (this.apiAuth && endpoint.startsWith("/v1/images/")) return this.apiAuth.poll<Record<string, unknown>>(response, this.timeout, 2_000);
      return response.json() as Promise<Record<string, unknown>>;
    }
  }

  private async handlePaymentAndRetryRaw(
    url: string,
    body: Record<string, unknown>,
    response: Response,
    forceFreshBlockhash = false
  ): Promise<Record<string, unknown>> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = await response.json() as Record<string, unknown>;
        if (respBody.accepts || respBody.x402Version) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch { /* ignore */ }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);

    if (!details.network?.startsWith("solana:")) {
      throw new PaymentError(
        `Expected Solana payment network, got: ${details.network}. Use LLMClient for Base payments.`
      );
    }

    const feePayer = (details.extra as { feePayer?: string })?.feePayer;
    if (!feePayer) throw new PaymentError("Missing feePayer in 402 extra field");

    const fromAddress = await this.getWalletAddress();
    const secretKey = await solanaKeyToBytes(this.privateKey);
    const extensions = ((paymentRequired as unknown) as Record<string, unknown>).extensions as Record<string, unknown> | undefined;

    const paymentPayload = await createSolanaPaymentPayload(
      secretKey,
      fromAddress,
      details.recipient,
      details.amount,
      feePayer,
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || url,
          this.apiUrl
        ),
        resourceDescription: details.resource?.description || "BlockRun Solana AI API call",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown>,
        extensions,
        rpcUrl: this.rpcUrl,
        rpcHeaders: this.rpcHeaders,
        forceFreshBlockhash,
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

    if (retryResponse.status === 402) {
      if (await isSafeStaleBlockhashResponse(retryResponse)) {
        throw new SafeStaleBlockhashError();
      }
      throw new PaymentError("Payment was rejected. Check your Solana USDC balance.");
    }

    if (!retryResponse.ok) {
      let errorBody: unknown;
      try { errorBody = await retryResponse.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error after payment: ${retryResponse.status}`, retryResponse.status, sanitizeErrorResponse(errorBody));
    }

    const costUsd = parseFloat(details.amount) / 1e6;
    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;

    return retryResponse.json() as Promise<Record<string, unknown>>;
  }

  private async getWithPaymentRaw(
    endpoint: string,
    params?: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const query = params ? "?" + new URLSearchParams(params).toString() : "";
    const url = `${this.apiUrl}${endpoint}${query}`;

    for (let staleRetries = 0; ; ) {
      const response = await this.fetchWithTimeout(url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
      });

      if (response.status === 402) {
        try {
          return await this.handleGetPaymentAndRetryRaw(url, endpoint, params, response, staleRetries > 0);
        } catch (error) {
          if (
            !(error instanceof SafeStaleBlockhashError) ||
            staleRetries >= STALE_BLOCKHASH_RETRY_BACKOFFS_MS.length
          ) throw error;
          await waitForStaleRetry(staleRetries++);
          continue;
        }
      }

      if (!response.ok) {
        let errorBody: unknown;
        try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
        throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
      }

      return response.json() as Promise<Record<string, unknown>>;
    }
  }

  private async handleGetPaymentAndRetryRaw(
    url: string,
    endpoint: string,
    params: Record<string, string> | undefined,
    response: Response,
    forceFreshBlockhash = false
  ): Promise<Record<string, unknown>> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = await response.json() as Record<string, unknown>;
        if (respBody.accepts || respBody.x402Version) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch { /* ignore */ }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);

    if (!details.network?.startsWith("solana:")) {
      throw new PaymentError(
        `Expected Solana payment network, got: ${details.network}. Use LLMClient for Base payments.`
      );
    }

    const feePayer = (details.extra as { feePayer?: string })?.feePayer;
    if (!feePayer) throw new PaymentError("Missing feePayer in 402 extra field");

    const fromAddress = await this.getWalletAddress();
    const secretKey = await solanaKeyToBytes(this.privateKey);
    const extensions = ((paymentRequired as unknown) as Record<string, unknown>).extensions as Record<string, unknown> | undefined;

    const paymentPayload = await createSolanaPaymentPayload(
      secretKey,
      fromAddress,
      details.recipient,
      details.amount,
      feePayer,
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || url,
          this.apiUrl
        ),
        resourceDescription: details.resource?.description || "BlockRun Solana AI API call",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown>,
        extensions,
        rpcUrl: this.rpcUrl,
        rpcHeaders: this.rpcHeaders,
        forceFreshBlockhash,
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

    if (retryResponse.status === 402) {
      if (await isSafeStaleBlockhashResponse(retryResponse)) {
        throw new SafeStaleBlockhashError();
      }
      throw new PaymentError("Payment was rejected. Check your Solana USDC balance.");
    }

    if (!retryResponse.ok) {
      let errorBody: unknown;
      try { errorBody = await retryResponse.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error after payment: ${retryResponse.status}`, retryResponse.status, sanitizeErrorResponse(errorBody));
    }

    const costUsd = parseFloat(details.amount) / 1e6;
    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;

    return retryResponse.json() as Promise<Record<string, unknown>>;
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await (this.apiAuth ? this.apiAuth.fetch.bind(this.apiAuth) : fetch)(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Convenience function: create SolanaLLMClient for sol.blockrun.ai.
 */
export function solanaClient(options: SolanaLLMClientOptions = {}): SolanaLLMClient {
  return new SolanaLLMClient({ ...options, apiUrl: SOLANA_API_URL });
}
