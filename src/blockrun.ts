/**
 * BlockrunClient — the x402-paying HTTP primitive for the BlockRun gateway.
 *
 * This is the **primitive** that every BlockRun API surface composes on top of:
 * a wallet, an x402 401-sign-replay handler, and four call shapes (get, post,
 * poll, stream). Per-API classes (LLMClient, ImageClient, SurfClient, …) are
 * being collapsed into Claude Code skills that drive this client directly.
 *
 * Why one primitive instead of one client per API surface:
 *   - Every BlockRun endpoint pays the same way (USDC via x402 on Base/Solana)
 *   - ~30-40 % of each existing client class is identical boilerplate
 *   - New API surfaces should ship as a skill (markdown) + path, not as a
 *     new TypeScript class + npm release
 *
 * Four call shapes:
 *   client.get<T>(path, params?)                — sync GET, e.g. /v1/surf/market/price
 *   client.post<T>(path, body?)                 — sync POST, e.g. /v1/surf/onchain/sql
 *   client.poll<T>(path, body?, { budgetMs })   — submit + poll, e.g. /v1/videos/generations
 *   client.stream<T>(path, body?)               — SSE iterator, e.g. /v1/chat/completions
 *
 * Usage:
 *   import { BlockrunClient } from "@blockrun/llm";
 *
 *   const br = new BlockrunClient({ privateKey: "0x..." });
 *
 *   // Surf endpoint (Tier 1, $0.001)
 *   const btc = await br.get("/v1/surf/market/price", { symbol: "BTC" });
 *
 *   // Raw on-chain SQL (Tier 3, $0.020)
 *   const rows = await br.post("/v1/surf/onchain/sql", {
 *     query: "SELECT block_number FROM ethereum.blocks ORDER BY block_number DESC LIMIT 1",
 *   });
 *
 *   // Long-running video generation (submit + poll, paid on success)
 *   const video = await br.poll("/v1/videos/generations", {
 *     model: "xai/grok-imagine-video",
 *     prompt: "a red apple spinning",
 *   });
 *
 *   // Streaming chat
 *   for await (const chunk of br.stream("/v1/chat/completions", {
 *     model: "anthropic/claude-sonnet-4-6",
 *     messages: [{ role: "user", content: "Hi" }],
 *     stream: true,
 *   })) {
 *     process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
 *   }
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type BlockrunClientOptions,
  type PollOptions,
  type Spending,
  APIError,
  PaymentError,
} from "./types";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "./x402";
import {
  validatePrivateKey,
  validateApiUrl,
  sanitizeErrorResponse,
} from "./validation";

const DEFAULT_API_URL = "https://blockrun.ai/api";
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_BUDGET_MS = 300_000; // 5 minutes
const MAX_SIGNED_AUTH_SECONDS = 600;

type QueryValue = string | number | boolean | null | undefined;
type QueryParams = Record<string, QueryValue | QueryValue[]>;

/**
 * The x402-paying HTTP primitive for the BlockRun gateway.
 *
 * One instance, one wallet, all endpoints. The four call shapes (get, post,
 * poll, stream) cover every endpoint type the gateway exposes.
 */
export class BlockrunClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;

  constructor(options: BlockrunClientOptions = {}) {
    const envKey =
      typeof process !== "undefined" && process.env
        ? process.env.BLOCKRUN_WALLET_KEY || process.env.BASE_CHAIN_WALLET_KEY
        : undefined;
    const privateKey = options.privateKey || envKey;

    if (!privateKey) {
      throw new Error(
        "Private key required. Pass privateKey in options or set BLOCKRUN_WALLET_KEY environment variable."
      );
    }

    validatePrivateKey(privateKey);
    this.privateKey = privateKey as `0x${string}`;
    this.account = privateKeyToAccount(privateKey as `0x${string}`);

    const apiUrl = options.apiUrl || DEFAULT_API_URL;
    validateApiUrl(apiUrl);
    this.apiUrl = apiUrl.replace(/\/$/, "");

    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  /**
   * GET a BlockRun endpoint. `path` is everything after `/api` (a leading
   * `/api` is tolerated and stripped). Query params are URL-encoded; arrays
   * become repeated keys (`?a=1&a=2`); undefined/null are dropped.
   */
  async get<T = unknown>(path: string, params?: QueryParams): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.requestWithPayment<T>(url, "GET");
  }

  /**
   * POST a BlockRun endpoint with a JSON body.
   */
  async post<T = unknown>(
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = this.buildUrl(path);
    return this.requestWithPayment<T>(url, "POST", body);
  }

  /**
   * Submit a long-running job and poll until it completes.
   *
   * Pattern: submit → 402 → sign → 202 `{ id, poll_url, status }` → loop GET
   * the poll_url with the SAME `PAYMENT-SIGNATURE` until status=completed (or
   * deadline exceeded). Settlement happens only when upstream returns 200 +
   * completed — upstream failure or caller giving up = no charge.
   *
   * If the gateway returns 200 directly on submit (no async surface), this
   * short-circuits and returns the body. Most long-running endpoints (image,
   * video, music, voice) return 202 with a poll_url.
   */
  async poll<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
    options?: PollOptions
  ): Promise<T> {
    const submitUrl = this.buildUrl(path);
    const budgetMs = options?.budgetMs ?? DEFAULT_POLL_BUDGET_MS;
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // Step 1: 402 with payment requirements
    const resp402 = await this.fetchWithTimeout(submitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

    if (resp402.status === 200) {
      // Synchronous response, no payment required (free endpoint or pre-authed)
      return resp402.json() as Promise<T>;
    }

    if (resp402.status !== 402) {
      await this.throwApiError(resp402, `poll submit failed (${submitUrl})`);
    }

    const paymentPayload = await this.signFrom402(resp402, submitUrl, {
      description: "BlockRun async job",
      maxTimeoutSeconds: MAX_SIGNED_AUTH_SECONDS,
    });

    // Step 2: submit with signature → 200/202
    const submitResp = await this.fetchWithTimeout(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body ?? {}),
    });

    if (submitResp.status === 402) {
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
    }
    if (submitResp.status !== 200 && submitResp.status !== 202) {
      await this.throwApiError(submitResp, `poll submit failed (${submitUrl})`);
    }

    if (submitResp.status === 200) {
      this.recordSpending();
      return submitResp.json() as Promise<T>;
    }

    const submitData = (await submitResp.json()) as {
      id?: string;
      poll_url?: string;
      status?: string;
    };
    if (!submitData.id || !submitData.poll_url) {
      throw new APIError(
        "Async submit response missing id/poll_url",
        submitResp.status,
        { response: submitData }
      );
    }

    const pollUrl = this.absolute(submitData.poll_url);
    const deadline = Date.now() + budgetMs;
    let lastStatus = submitData.status || "queued";

    while (Date.now() < deadline) {
      await sleep(intervalMs);

      const pollResp = await this.fetchWithTimeout(pollUrl, {
        method: "GET",
        headers: { "PAYMENT-SIGNATURE": paymentPayload },
      });

      let pollData: Record<string, unknown> = {};
      try {
        pollData = (await pollResp.json()) as Record<string, unknown>;
      } catch {
        /* keep empty */
      }

      lastStatus = (pollData.status as string) || lastStatus;

      if (
        pollResp.status === 202 &&
        (lastStatus === "queued" || lastStatus === "in_progress")
      ) {
        continue;
      }

      if (lastStatus === "failed") {
        throw new APIError(
          `Upstream job failed: ${(pollData.error as string) || "unknown"}`,
          pollResp.status,
          sanitizeErrorResponse(pollData)
        );
      }

      if (pollResp.status === 200 && lastStatus === "completed") {
        this.recordSpending();
        return pollData as T;
      }

      // 504 on poll = transient gateway hiccup, keep retrying
      if (
        pollResp.status !== 200 &&
        pollResp.status !== 202 &&
        pollResp.status !== 504
      ) {
        await this.throwApiError(pollResp, `poll failed (${pollUrl})`);
      }
    }

    throw new APIError(
      `Job did not complete within ${Math.round(budgetMs / 1000)}s ` +
        `(last status: ${lastStatus}). No payment was taken.`,
      504,
      { id: submitData.id, last_status: lastStatus }
    );
  }

  /**
   * Stream a Server-Sent Events endpoint.
   *
   * Yields each `data: …` line parsed as JSON. Stops when the upstream emits
   * `data: [DONE]` or closes the connection. Caller is responsible for typing
   * the chunk shape; pass a generic for typed yields.
   *
   * Example — streaming chat:
   *   for await (const chunk of br.stream<ChatChunk>("/v1/chat/completions", {
   *     model: "anthropic/claude-sonnet-4-6",
   *     messages: [{ role: "user", content: "Hi" }],
   *     stream: true,
   *   })) {
   *     process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
   *   }
   */
  async *stream<T = unknown>(
    path: string,
    body?: Record<string, unknown>
  ): AsyncGenerator<T, void, undefined> {
    const url = this.buildUrl(path);
    const requestBody = JSON.stringify(body ?? {});

    // First call: trigger 402, then sign and replay with stream
    const resp402 = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    let streamResp: Response;
    if (resp402.status === 200) {
      streamResp = resp402;
    } else if (resp402.status === 402) {
      const paymentPayload = await this.signFrom402(resp402, url, {
        description: "BlockRun stream",
      });
      streamResp = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": paymentPayload,
        },
        body: requestBody,
      });
      if (streamResp.status === 402) {
        throw new PaymentError(
          "Payment was rejected. Check your wallet balance."
        );
      }
      if (!streamResp.ok) {
        await this.throwApiError(streamResp, `stream failed after payment (${url})`);
      }
      this.recordSpending();
    } else {
      await this.throwApiError(resp402, `stream failed (${url})`);
      return; // unreachable
    }

    if (!streamResp.body) {
      throw new APIError("Stream response has no body", streamResp.status, {});
    }

    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          try {
            yield JSON.parse(data) as T;
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // --------------------------------------------------------------------
  // Internal: shared infrastructure
  // --------------------------------------------------------------------

  private buildUrl(path: string, params?: QueryParams): string {
    let normalized = path.startsWith("/") ? path : `/${path}`;
    if (normalized.startsWith("/api/")) {
      normalized = normalized.slice(4);
    }
    const base = `${this.apiUrl}${normalized}`;
    if (!params) return base;

    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v === undefined || v === null) continue;
          qs.append(key, String(v));
        }
      } else {
        qs.append(key, String(value));
      }
    }
    const query = qs.toString();
    return query ? `${base}?${query}` : base;
  }

  private absolute(url: string): string {
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    const base = this.apiUrl.endsWith("/api")
      ? this.apiUrl.slice(0, -"/api".length)
      : this.apiUrl;
    return `${base}${url}`;
  }

  private async requestWithPayment<T>(
    url: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>
  ): Promise<T> {
    const init: RequestInit = { method };
    if (method === "POST") {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body ?? {});
    }

    const response = await this.fetchWithTimeout(url, init);

    if (response.status === 402) {
      return this.handlePaymentAndRetry<T>(url, method, body, response);
    }

    if (!response.ok) {
      await this.throwApiError(response, `${method} ${url} failed`);
    }

    return response.json() as Promise<T>;
  }

  private async handlePaymentAndRetry<T>(
    url: string,
    method: "GET" | "POST",
    body: Record<string, unknown> | undefined,
    response: Response
  ): Promise<T> {
    const paymentPayload = await this.signFrom402(response, url, {
      description: "BlockRun",
    });

    const retryInit: RequestInit = {
      method,
      headers: { "PAYMENT-SIGNATURE": paymentPayload },
    };
    if (method === "POST") {
      retryInit.headers = {
        ...retryInit.headers,
        "Content-Type": "application/json",
      };
      retryInit.body = JSON.stringify(body ?? {});
    }

    const retry = await this.fetchWithTimeout(url, retryInit);

    if (retry.status === 402) {
      throw new PaymentError(
        "Payment was rejected. Check your wallet balance."
      );
    }
    if (!retry.ok) {
      await this.throwApiError(retry, `${method} ${url} failed after payment`);
    }

    this.recordSpending();
    return retry.json() as Promise<T>;
  }

  /**
   * Read a 402 response's payment requirements (header or body), then sign and
   * return the base64 PAYMENT-SIGNATURE payload. Also records the cost-to-be
   * onto the response context (settled on `recordSpending`).
   */
  private async signFrom402(
    response: Response,
    url: string,
    opts: { description: string; maxTimeoutSeconds?: number }
  ): Promise<string> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = (await response.json()) as Record<string, unknown>;
        if (
          respBody.x402Version !== undefined ||
          respBody.accepts !== undefined
        ) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch {
        /* ignore */
      }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);
    this.pendingCostUsd = parseFloat(details.amount) / 1e6;

    return createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: details.resource?.url || url,
        resourceDescription: details.resource?.description || opts.description,
        maxTimeoutSeconds: Math.max(
          details.maxTimeoutSeconds || 0,
          opts.maxTimeoutSeconds || 300
        ),
        extra: details.extra,
      }
    );
  }

  /** Accumulates the most-recent pending cost; settled by recordSpending. */
  private pendingCostUsd: number = 0;

  private recordSpending(): void {
    if (this.pendingCostUsd > 0) {
      this.sessionCalls += 1;
      this.sessionTotalUsd += this.pendingCostUsd;
      this.pendingCostUsd = 0;
    }
  }

  private async throwApiError(resp: Response, prefix: string): Promise<never> {
    let errorBody: unknown;
    try {
      errorBody = await resp.json();
    } catch {
      errorBody = { error: "Request failed" };
    }
    throw new APIError(
      `${prefix}: HTTP ${resp.status}`,
      resp.status,
      sanitizeErrorResponse(errorBody)
    );
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // --------------------------------------------------------------------
  // Public surface: wallet + spending
  // --------------------------------------------------------------------

  getWalletAddress(): string {
    return this.account.address;
  }

  getSpending(): Spending {
    return { totalUsd: this.sessionTotalUsd, calls: this.sessionCalls };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default BlockrunClient;
