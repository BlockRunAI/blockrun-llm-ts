/**
 * BlockRun Surf Client — pay-per-call crypto data via x402 micropayments.
 *
 * Surf aggregates 84+ endpoints across CEX/DEX market data, on-chain SQL,
 * wallet intelligence, prediction markets, social analytics, and news under
 * a single OpenAPI surface mounted at `/api/v1/surf/*`.
 *
 * Pricing tiers (flat per-call, USDC on Base):
 *   Tier 1 — $0.001/call (prices, rankings, lists, news, simple reads)
 *   Tier 2 — $0.005/call (order books, candles, search, wallet details)
 *   Tier 3 — $0.020/call (on-chain SQL, schema introspection, chat)
 *
 * Because the catalog is large and evolving, this client deliberately
 * exposes a thin `get` / `post` pair instead of 84 typed wrappers. Pass the
 * path (with or without the `/v1/surf` prefix) and either query params or a
 * JSON body. The full endpoint inventory lives at
 * https://blockrun.ai/marketplace/surf.
 *
 * Usage:
 *   import { SurfClient } from "@blockrun/llm";
 *
 *   const surf = new SurfClient({ privateKey: "0x..." });
 *
 *   // Tier 1 — token price ($0.001)
 *   const btc = await surf.get("/market/price", { symbol: "BTC" });
 *
 *   // Tier 2 — order book ($0.005)
 *   const book = await surf.get("/exchange/depth", {
 *     exchange: "binance",
 *     symbol: "BTC-USDT",
 *   });
 *
 *   // Tier 3 — raw on-chain SQL ($0.020)
 *   const rows = await surf.post("/onchain/sql", {
 *     query: "SELECT block_number FROM ethereum.blocks ORDER BY block_number DESC LIMIT 5",
 *   });
 *
 *   // Typed responses via generic
 *   type Price = { symbol: string; price: number; timestamp: string };
 *   const typed = await surf.get<Price>("/market/price", { symbol: "ETH" });
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type SurfClientOptions,
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
const SURF_PREFIX = "/v1/surf";

type QueryValue = string | number | boolean | null | undefined;
type QueryParams = Record<string, QueryValue | QueryValue[]>;

export class SurfClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;

  constructor(options: SurfClientOptions = {}) {
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
   * GET a Surf endpoint. `path` is everything after `/v1/surf` (a leading
   * `/v1/surf` is tolerated and stripped). Query params are URL-encoded;
   * arrays become repeated keys (`?a=1&a=2`).
   */
  async get<T = unknown>(path: string, params?: QueryParams): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.requestWithPayment<T>(url, "GET");
  }

  /**
   * POST a Surf endpoint with a JSON body. Same path normalization as `get`.
   */
  async post<T = unknown>(
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = this.buildUrl(path);
    return this.requestWithPayment<T>(url, "POST", body);
  }

  private buildUrl(path: string, params?: QueryParams): string {
    let normalized = path.startsWith("/") ? path : `/${path}`;
    if (!normalized.startsWith(SURF_PREFIX)) {
      normalized = `${SURF_PREFIX}${normalized}`;
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
      await this.throwApiError(response, `Surf request failed (${method} ${url})`);
    }

    return response.json() as Promise<T>;
  }

  private async handlePaymentAndRetry<T>(
    url: string,
    method: "GET" | "POST",
    body: Record<string, unknown> | undefined,
    response: Response
  ): Promise<T> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = (await response.json()) as Record<string, unknown>;
        if (respBody.x402Version !== undefined || respBody.accepts !== undefined) {
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

    const paymentPayload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: details.resource?.url || url,
        resourceDescription: details.resource?.description || "BlockRun Surf",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
      }
    );

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
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
    }
    if (!retry.ok) {
      await this.throwApiError(retry, `Surf request failed after payment (${method} ${url})`);
    }

    return retry.json() as Promise<T>;
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

  getWalletAddress(): string {
    return this.account.address;
  }
}

export default SurfClient;
