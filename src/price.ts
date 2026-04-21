/**
 * BlockRun Price Client - Pyth-backed market data via x402.
 *
 * Payment gating mirrors CategoryConfig.paid in the backend:
 *   crypto, fx, commodity      → FREE across price + history + list
 *   usstock, stocks/{market}   → PAID for price + history; list always free
 *
 * Usage:
 *   import { PriceClient } from "@blockrun/llm";
 *
 *   const p = new PriceClient({ privateKey: "0x..." });
 *   const btc = await p.price("crypto", "BTC-USD");
 *   const aapl = await p.price("stocks", "AAPL", { market: "us" });
 *   const bars = await p.history("stocks", "AAPL", { market: "us",
 *     from: 1700000000, to: 1710000000 });
 *   const symbols = await p.listSymbols("crypto", { query: "sol" });
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type PriceClientOptions,
  type PriceCategory,
  type PricePoint,
  type PriceHistoryResponse,
  type SymbolListResponse,
  type PriceOptions,
  type HistoryOptions,
  type ListOptions,
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
const DEFAULT_TIMEOUT = 30_000;

export class PriceClient {
  private account: Account | null = null;
  private privateKey: `0x${string}` | null = null;
  private apiUrl: string;
  private timeout: number;

  constructor(options: PriceClientOptions = {}) {
    const envKey =
      typeof process !== "undefined" && process.env
        ? process.env.BLOCKRUN_WALLET_KEY || process.env.BASE_CHAIN_WALLET_KEY
        : undefined;
    const privateKey = options.privateKey || envKey;
    const requireWallet = options.requireWallet ?? true;

    if (!privateKey && requireWallet) {
      throw new Error(
        "Private key required for paid endpoints. Pass privateKey in options, set BLOCKRUN_WALLET_KEY, or pass requireWallet: false for free-only usage."
      );
    }
    if (privateKey) {
      validatePrivateKey(privateKey);
      this.privateKey = privateKey as `0x${string}`;
      this.account = privateKeyToAccount(privateKey as `0x${string}`);
    }

    const apiUrl = options.apiUrl || DEFAULT_API_URL;
    validateApiUrl(apiUrl);
    this.apiUrl = apiUrl.replace(/\/$/, "");

    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  async price(
    category: PriceCategory,
    symbol: string,
    options?: PriceOptions
  ): Promise<PricePoint> {
    if (!symbol) throw new Error("symbol is required");
    const path = categoryPath(category, options?.market, "price", symbol);
    const query: Record<string, string> = {};
    if (options?.session) query.session = options.session;
    const data = (await this.getWithPayment(path, query)) as Record<string, unknown>;
    return {
      symbol: (data.symbol as string) ?? symbol.toUpperCase(),
      price: data.price as number,
      publishTime: data.publishTime as number | undefined,
      confidence: data.confidence as number | undefined,
      feedId: data.feedId as string | undefined,
      timestamp: data.timestamp as string | undefined,
      assetType: data.assetType as string | undefined,
      category: data.category as string | undefined,
      source: data.source as string | undefined,
      free: data.free as boolean | undefined,
    };
  }

  async history(
    category: PriceCategory,
    symbol: string,
    options: HistoryOptions
  ): Promise<PriceHistoryResponse> {
    if (!symbol) throw new Error("symbol is required");
    if (!options.from || options.from <= 0) {
      throw new Error("history requires options.from (unix seconds)");
    }
    const path = categoryPath(category, options.market, "history", symbol);
    const query: Record<string, string> = {
      resolution: options.resolution ?? "D",
      from: String(options.from),
    };
    if (options.to) query.to = String(options.to);
    if (options.session) query.session = options.session;
    const data = (await this.getWithPayment(path, query)) as Record<string, unknown>;
    return {
      symbol: (data.symbol as string) ?? symbol.toUpperCase(),
      resolution: (data.resolution as string) ?? (options.resolution ?? "D"),
      from: data.from as number | undefined,
      to: data.to as number | undefined,
      bars: (data.bars as PriceHistoryResponse["bars"]) ?? [],
      source: data.source as string | undefined,
      category: data.category as string | undefined,
    };
  }

  async listSymbols(
    category: PriceCategory,
    options?: ListOptions
  ): Promise<SymbolListResponse> {
    const path = categoryPath(category, options?.market, "list");
    const query: Record<string, string> = {
      limit: String(options?.limit && options.limit > 0 ? options.limit : 100),
    };
    if (options?.query) query.q = options.query;

    const data = await this.getWithPayment(path, query);
    if (Array.isArray(data)) {
      return { symbols: data as Array<Record<string, unknown>>, count: data.length };
    }
    const obj = data as Record<string, unknown>;
    const symbols = (obj.symbols ?? obj.feeds ?? []) as Array<Record<string, unknown>>;
    return {
      symbols,
      count: (obj.count as number | undefined) ?? symbols.length,
    };
  }

  getWalletAddress(): string | null {
    return this.account?.address ?? null;
  }

  private async getWithPayment(
    endpoint: string,
    query: Record<string, string>
  ): Promise<unknown> {
    const url = buildUrl(`${this.apiUrl}${endpoint}`, query);

    const response = await this.fetchWithTimeout(url, { method: "GET" });

    if (response.status === 402) {
      if (!this.privateKey || !this.account) {
        throw new PaymentError(
          `${endpoint} returned 402 Payment Required but no wallet is configured.`
        );
      }
      return this.payAndRetry(url, response);
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
    return response.json();
  }

  private async payAndRetry(url: string, response: Response): Promise<unknown> {
    if (!this.privateKey || !this.account) {
      throw new PaymentError("Wallet required to sign payment.");
    }
    let paymentHeader = response.headers.get("payment-required");
    if (!paymentHeader) {
      try {
        const respBody = (await response.json()) as Record<string, unknown>;
        if (respBody.x402) {
          paymentHeader = btoa(JSON.stringify(respBody.x402));
        } else if (respBody.accepts) {
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
        resourceDescription: details.resource?.description || "BlockRun Price Data",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
      }
    );

    const retry = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: { "PAYMENT-SIGNATURE": paymentPayload },
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
    return retry.json();
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function categoryPath(
  category: PriceCategory,
  market: string | undefined,
  kind: "price" | "history" | "list",
  symbol?: string
): string {
  let base: string;
  if (category === "stocks") {
    if (!market) {
      throw new Error("market is required when category === 'stocks'");
    }
    base = `/v1/stocks/${market}`;
  } else if (["crypto", "fx", "commodity", "usstock"].includes(category)) {
    base = `/v1/${category}`;
  } else {
    throw new Error(`unknown category: ${category}`);
  }
  if (!symbol) return `${base}/${kind}`;
  return `${base}/${kind}/${encodeURIComponent(symbol.toUpperCase())}`;
}

function buildUrl(base: string, query: Record<string, string>): string {
  const params = Object.entries(query);
  if (params.length === 0) return base;
  const qs = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}?${qs}`;
}

export default PriceClient;
