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
  ImageResponse,
  ImageEditOptions,
  Spending,
  SearchResult,
  SearchOptions,
  XUserLookupResponse,
  XFollowersResponse,
  XFollowingsResponse,
  XUserInfoResponse,
  XVerifiedFollowersResponse,
  XTweetsResponse,
  XMentionsResponse,
  XTweetLookupResponse,
  XTweetRepliesResponse,
  XTweetThreadResponse,
  XSearchResponse,
  XTrendingResponse,
  XArticlesRisingResponse,
  XAuthorAnalyticsResponse,
  XCompareAuthorsResponse,
} from "./types";
import { APIError, PaymentError } from "./types";
import {
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  SOLANA_NETWORK,
} from "./x402";
import { solanaKeyToBytes, solanaPublicKey } from "./solana-wallet";
import { sanitizeErrorResponse, validateApiUrl, validateResourceUrl } from "./validation";

const SOLANA_API_URL = "https://sol.blockrun.ai/api";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT = 60000;
const SDK_VERSION = "0.3.0";
const USER_AGENT = `blockrun-ts/${SDK_VERSION}`;

export interface SolanaLLMClientOptions {
  /** bs58-encoded Solana secret key (64 bytes). Optional if SOLANA_WALLET_KEY env var is set. */
  privateKey?: string;
  /** API endpoint URL (default: https://sol.blockrun.ai/api) */
  apiUrl?: string;
  /** Solana RPC URL (default: https://api.mainnet-beta.solana.com) */
  rpcUrl?: string;
  /** Request timeout in milliseconds (default: 60000) */
  timeout?: number;
}

export class SolanaLLMClient {
  static readonly SOLANA_API_URL = SOLANA_API_URL;

  private privateKey: string;
  private apiUrl: string;
  private rpcUrl: string;
  private timeout: number;
  private sessionTotalUsd = 0;
  private sessionCalls = 0;
  private addressCache: string | null = null;

  constructor(options: SolanaLLMClientOptions = {}) {
    const envKey = typeof process !== "undefined" && process.env
      ? process.env.SOLANA_WALLET_KEY
      : undefined;
    const privateKey = options.privateKey || envKey;

    if (!privateKey) {
      throw new Error(
        "Private key required. Pass privateKey in options or set SOLANA_WALLET_KEY environment variable."
      );
    }

    this.privateKey = privateKey;

    const apiUrl = options.apiUrl || SOLANA_API_URL;
    validateApiUrl(apiUrl);
    this.apiUrl = apiUrl.replace(/\/$/, "");

    this.rpcUrl = options.rpcUrl || "https://api.mainnet-beta.solana.com";
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
    });
    return result.choices[0].message.content || "";
  }

  /** Full chat completion (OpenAI-compatible). */
  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    options?: ChatCompletionOptions
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options?.maxTokens || DEFAULT_MAX_TOKENS,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.topP !== undefined) body.top_p = options.topP;
    if (options?.searchParameters !== undefined) body.search_parameters = options.searchParameters;
    else if (options?.search === true) body.search_parameters = { mode: "on" };
    if (options?.tools !== undefined) body.tools = options.tools;
    if (options?.toolChoice !== undefined) body.tool_choice = options.toolChoice;
    return this.requestWithPayment("/v1/chat/completions", body);
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
        headers: { "Content-Type": "application/json" },
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
  async imageEdit(prompt: string, image: string, options?: ImageEditOptions): Promise<ImageResponse> {
    const body: Record<string, unknown> = {
      model: options?.model || "openai/gpt-image-1",
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

  // ============================================================
  // X/Twitter endpoints (powered by AttentionVC)
  // ============================================================

  async xUserLookup(usernames: string | string[]): Promise<XUserLookupResponse> {
    const names = Array.isArray(usernames) ? usernames : [usernames];
    const data = await this.requestWithPaymentRaw("/v1/x/users/lookup", { usernames: names });
    return data as unknown as XUserLookupResponse;
  }

  async xFollowers(username: string, cursor?: string): Promise<XFollowersResponse> {
    const body: Record<string, unknown> = { username };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/followers", body);
    return data as unknown as XFollowersResponse;
  }

  async xFollowings(username: string, cursor?: string): Promise<XFollowingsResponse> {
    const body: Record<string, unknown> = { username };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/followings", body);
    return data as unknown as XFollowingsResponse;
  }

  async xUserInfo(username: string): Promise<XUserInfoResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/users/info", { username });
    return data as unknown as XUserInfoResponse;
  }

  async xVerifiedFollowers(userId: string, cursor?: string): Promise<XVerifiedFollowersResponse> {
    const body: Record<string, unknown> = { userId };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/verified-followers", body);
    return data as unknown as XVerifiedFollowersResponse;
  }

  async xUserTweets(username: string, includeReplies = false, cursor?: string): Promise<XTweetsResponse> {
    const body: Record<string, unknown> = { username, includeReplies };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/tweets", body);
    return data as unknown as XTweetsResponse;
  }

  async xUserMentions(username: string, sinceTime?: string, untilTime?: string, cursor?: string): Promise<XMentionsResponse> {
    const body: Record<string, unknown> = { username };
    if (sinceTime !== undefined) body.sinceTime = sinceTime;
    if (untilTime !== undefined) body.untilTime = untilTime;
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/users/mentions", body);
    return data as unknown as XMentionsResponse;
  }

  async xTweetLookup(tweetIds: string | string[]): Promise<XTweetLookupResponse> {
    const ids = Array.isArray(tweetIds) ? tweetIds : [tweetIds];
    const data = await this.requestWithPaymentRaw("/v1/x/tweets/lookup", { tweet_ids: ids });
    return data as unknown as XTweetLookupResponse;
  }

  async xTweetReplies(tweetId: string, queryType = "Latest", cursor?: string): Promise<XTweetRepliesResponse> {
    const body: Record<string, unknown> = { tweetId, queryType };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/tweets/replies", body);
    return data as unknown as XTweetRepliesResponse;
  }

  async xTweetThread(tweetId: string, cursor?: string): Promise<XTweetThreadResponse> {
    const body: Record<string, unknown> = { tweetId };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/tweets/thread", body);
    return data as unknown as XTweetThreadResponse;
  }

  async xSearch(query: string, queryType = "Latest", cursor?: string): Promise<XSearchResponse> {
    const body: Record<string, unknown> = { query, queryType };
    if (cursor !== undefined) body.cursor = cursor;
    const data = await this.requestWithPaymentRaw("/v1/x/search", body);
    return data as unknown as XSearchResponse;
  }

  async xTrending(): Promise<XTrendingResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/trending", {});
    return data as unknown as XTrendingResponse;
  }

  async xArticlesRising(): Promise<XArticlesRisingResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/articles/rising", {});
    return data as unknown as XArticlesRisingResponse;
  }

  async xAuthorAnalytics(handle: string): Promise<XAuthorAnalyticsResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/authors", { handle });
    return data as unknown as XAuthorAnalyticsResponse;
  }

  async xCompareAuthors(handle1: string, handle2: string): Promise<XCompareAuthorsResponse> {
    const data = await this.requestWithPaymentRaw("/v1/x/compare", { handle1, handle2 });
    return data as unknown as XCompareAuthorsResponse;
  }

  // ── Prediction Markets (Powered by Predexon) ────────────────────────────

  async pm(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.getWithPaymentRaw(`/v1/pm/${path}`, params);
  }

  async pmQuery(path: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestWithPaymentRaw(`/v1/pm/${path}`, query);
  }

  /** Get session spending. */
  getSpending(): Spending {
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
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    });

    if (response.status === 402) {
      return this.handlePaymentAndRetry(url, body, response);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
    }

    return response.json() as Promise<ChatResponse>;
  }

  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
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
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    });

    if (response.status === 402) {
      return this.handlePaymentAndRetryRaw(url, body, response);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

  private async handlePaymentAndRetryRaw(
    url: string,
    body: Record<string, unknown>,
    response: Response
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

    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
    });

    if (response.status === 402) {
      return this.handleGetPaymentAndRetryRaw(url, endpoint, params, response);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

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
      return await fetch(url, { ...options, signal: controller.signal });
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
