/**
 * BlockRun Search Client - Standalone Grok Live Search via x402 micropayments.
 *
 * Backend endpoint: POST /api/v1/search
 * Pricing: $0.025/source + margin (default 10 sources ≈ $0.26).
 *
 * Usage:
 *   import { SearchClient } from "@blockrun/llm";
 *
 *   const client = new SearchClient({ privateKey: "0x..." });
 *   const result = await client.search("Latest news on x402 adoption", {
 *     sources: ["x", "web"],
 *   });
 *   console.log(result.summary);
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type SearchClientOptions,
  type SearchResult,
  type SearchOptions,
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

export class SearchClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;

  constructor(options: SearchClientOptions = {}) {
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

  async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    if (!query || query.length > 1000) {
      throw new Error("query must be 1-1000 characters");
    }
    const maxResults = options?.maxResults ?? 10;
    if (maxResults < 1 || maxResults > 50) {
      throw new Error("maxResults must be between 1 and 50");
    }

    const body: Record<string, unknown> = {
      query,
      max_results: maxResults,
    };
    if (options?.sources) body.sources = options.sources;
    if (options?.fromDate) body.from_date = options.fromDate;
    if (options?.toDate) body.to_date = options.toDate;

    return this.requestWithPayment("/v1/search", body);
  }

  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<SearchResult> {
    const url = `${this.apiUrl}${endpoint}`;

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.status === 402) {
      return this.handlePaymentAndRetry(url, body, response);
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

    return response.json() as Promise<SearchResult>;
  }

  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<SearchResult> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = (await response.json()) as Record<string, unknown>;
        if (respBody.x402 || respBody.accepts) {
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
        resourceDescription: details.resource?.description || "BlockRun Search",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
      }
    );

    const retry = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body),
    });

    if (retry.status === 402) {
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
    }
    if (!retry.ok) {
      let errorBody: unknown;
      try {
        errorBody = await retry.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error after payment: ${retry.status}`,
        retry.status,
        sanitizeErrorResponse(errorBody)
      );
    }

    return retry.json() as Promise<SearchResult>;
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

export default SearchClient;
