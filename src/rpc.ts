/**
 * BlockRun RPC Client - Multi-chain JSON-RPC (Tatum gateway) via x402 micropayments.
 *
 * One endpoint, 40+ chains: Ethereum, Base, Solana, Polygon, BSC, Arbitrum,
 * Optimism, Avalanche, Bitcoin, Sui, and more. Standard JSON-RPC 2.0
 * passthrough — no API key, pay-per-call in USDC.
 *
 * SECURITY NOTE - Private Key Handling:
 * Your private key NEVER leaves your machine. Here's what happens:
 * 1. Key stays local - only used to sign an EIP-712 typed data message
 * 2. Only the SIGNATURE is sent in the PAYMENT-SIGNATURE header
 * 3. BlockRun verifies the signature on-chain via Coinbase CDP facilitator
 *
 * Usage:
 *   import { RpcClient } from '@blockrun/llm';
 *
 *   const client = new RpcClient({ privateKey: '0x...' });
 *
 *   // EVM chains speak eth_* JSON-RPC
 *   const block = await client.call('ethereum', 'eth_blockNumber');
 *   console.log(block.result); // e.g. "0x1499f7c"
 *
 *   const balance = await client.call('base', 'eth_getBalance', [
 *     '0x4200000000000000000000000000000000000006',
 *     'latest',
 *   ]);
 *
 *   // Non-EVM chains speak their native JSON-RPC
 *   const slot = await client.call('solana', 'getSlot');
 *
 *   // Batch: one payment, per-element pricing ($0.002 x N)
 *   const out = await client.batch('polygon', [
 *     { method: 'eth_blockNumber' },
 *     { method: 'eth_gasPrice' },
 *   ]);
 *
 * Pricing:
 *   Flat $0.002 per JSON-RPC call; a batch charges per element.
 *
 * Networks:
 *   40 curated chains (see SUPPORTED_NETWORKS) plus common aliases
 *   (eth, arb, op, matic, bnb, avax, sol, btc, xrp, dot, ...). Unknown but
 *   well-formed slugs fall through to a generic `{slug}-mainnet` gateway
 *   attempt, so new Tatum chains work without an SDK update.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type RpcClientOptions,
  type RpcResponse,
  type RpcBatchRequest,
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
const DEFAULT_TIMEOUT = 60_000; // upstream gateway timeout is 20s

/**
 * Flat price per JSON-RPC call (batch = N x this). Informational only —
 * the actual quote always comes from the 402 challenge.
 */
export const RPC_PRICE_USD = 0.002;

/**
 * Curated chains accepted by /v1/rpc/{network}. Mirrors the backend chain
 * registry (verified live 2026-06-07). EVM chains use eth_* JSON-RPC;
 * non-EVM (Solana / UTXO / NEAR / Sui / XRP Ledger / Polkadot) speak their
 * own JSON-RPC dialect.
 */
export const SUPPORTED_NETWORKS = [
  // EVM
  "ethereum",
  "base",
  "arbitrum",
  "arbitrum-nova",
  "optimism",
  "polygon",
  "bsc",
  "avalanche",
  "fantom",
  "cronos",
  "celo",
  "gnosis",
  "zksync",
  "berachain",
  "unichain",
  "monad",
  "chiliz",
  "moonbeam",
  "aurora",
  "flare",
  "oasis",
  "kaia",
  "sonic",
  "xdc",
  "abstract",
  "hyperevm",
  "plume",
  "ronin",
  "rootstock",
  // Non-EVM (JSON-RPC-compatible)
  "solana",
  "bitcoin",
  "litecoin",
  "dogecoin",
  "bitcoin-cash",
  "near",
  "sui",
  "ripple",
  "polkadot",
  "kusama",
  "zcash",
] as const;

export type RpcNetwork = (typeof SUPPORTED_NETWORKS)[number] | (string & {});

/** Common short names the gateway also accepts (resolved server-side). */
export const NETWORK_ALIASES: Record<string, string> = {
  eth: "ethereum",
  arb: "arbitrum",
  "arbitrum-one": "arbitrum",
  "arb-one": "arbitrum",
  "arb-nova": "arbitrum-nova",
  op: "optimism",
  matic: "polygon",
  pol: "polygon",
  bnb: "bsc",
  binance: "bsc",
  "binance-smart-chain": "bsc",
  avax: "avalanche",
  ftm: "fantom",
  bera: "berachain",
  klaytn: "kaia",
  chz: "chiliz",
  hyperliquid: "hyperevm",
  rsk: "rootstock",
  sol: "solana",
  btc: "bitcoin",
  ltc: "litecoin",
  doge: "dogecoin",
  bch: "bitcoin-cash",
  xrp: "ripple",
  xrpl: "ripple",
  dot: "polkadot",
  zec: "zcash",
};

/**
 * BlockRun Multi-chain RPC Client.
 *
 * Standard JSON-RPC 2.0 access to 40+ chains through BlockRun's Tatum
 * gateway with automatic x402 micropayments on Base chain.
 *
 * Flat $0.002 per call; a JSON-RPC batch charges per element.
 */
export class RpcClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;

  constructor(options: RpcClientOptions = {}) {
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
   * Make a single JSON-RPC 2.0 call. Flat $0.002.
   *
   * @param network - Chain name (e.g. "ethereum", "base", "solana") or a
   *                  common alias ("eth", "sol", "matic", ...). See
   *                  SUPPORTED_NETWORKS / NETWORK_ALIASES.
   * @param method - Chain RPC method, e.g. "eth_blockNumber", "eth_call",
   *                 "eth_getBalance" (EVM) or "getSlot", "getAccountInfo"
   *                 (Solana).
   * @param params - Method-specific params array (optional).
   * @returns RpcResponse with `result` (or JSON-RPC `error`), plus
   *          `network`, `cacheHit` and `txHash` metadata.
   *
   * @example
   * const block = await client.call('ethereum', 'eth_blockNumber');
   * console.log(parseInt(block.result as string, 16));
   */
  async call<T = unknown>(
    network: RpcNetwork,
    method: string,
    params?: unknown[]
  ): Promise<RpcResponse<T>> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method };
    if (params !== undefined) body.params = params;

    const { data, headers } = await this.requestWithPayment(network, body);
    return this.toResponse<T>(data, headers);
  }

  /**
   * Make a JSON-RPC 2.0 batch call. Priced per element ($0.002 x N).
   *
   * @param network - Chain name or alias (see {@link call}).
   * @param requests - Requests, each with a `method` and optional
   *                   `params` / `id`. `jsonrpc` and missing ids are
   *                   filled in automatically.
   * @returns Array of RpcResponse, in upstream order.
   *
   * @example
   * const out = await client.batch('base', [
   *   { method: 'eth_blockNumber' },
   *   { method: 'eth_gasPrice' },
   * ]);
   */
  async batch(
    network: RpcNetwork,
    requests: RpcBatchRequest[]
  ): Promise<RpcResponse[]> {
    if (!requests.length) {
      throw new Error("batch requires at least one request");
    }
    const body = requests.map((req, i) => {
      if (!req.method) throw new Error(`batch request ${i} is missing 'method'`);
      return { jsonrpc: "2.0", id: i + 1, ...req };
    });

    const { data, headers } = await this.requestWithPayment(network, body);
    const items = Array.isArray(data) ? data : [data];
    return items.map((item) => this.toResponse(item, headers));
  }

  private toResponse<T>(data: unknown, headers: Headers): RpcResponse<T> {
    const base: RpcResponse<T> =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? ({ ...(data as Record<string, unknown>) } as RpcResponse<T>)
        : ({ result: data } as RpcResponse<T>);
    const network = headers.get("x-network");
    if (network) base.network = network;
    base.cacheHit = (headers.get("x-cache") || "").toUpperCase() === "HIT";
    const txHash = headers.get("x-payment-receipt") || headers.get("X-Payment-Receipt");
    if (txHash) base.txHash = txHash;
    return base;
  }

  private async requestWithPayment(
    network: string,
    body: unknown
  ): Promise<{ data: unknown; headers: Headers }> {
    const endpoint = `/v1/rpc/${network}`;
    const url = `${this.apiUrl}${endpoint}`;

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.status === 402) {
      return this.handlePaymentAndRetry(url, endpoint, body, response);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
    }

    return { data: await response.json(), headers: response.headers };
  }

  private async handlePaymentAndRetry(
    url: string,
    endpoint: string,
    body: unknown,
    response: Response
  ): Promise<{ data: unknown; headers: Headers }> {
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = (await response.json()) as Record<string, unknown>;
        if (respBody.x402 || respBody.accepts) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch { /* ignore */ }
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
        resourceUrl: details.resource?.url || `${this.apiUrl}${endpoint}`,
        resourceDescription: details.resource?.description || "BlockRun Multi-chain RPC",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
      }
    );

    const retryResponse = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body),
    });

    if (retryResponse.status === 402) {
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
    }

    if (!retryResponse.ok) {
      let errorBody: unknown;
      try { errorBody = await retryResponse.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error after payment: ${retryResponse.status}`, retryResponse.status, sanitizeErrorResponse(errorBody));
    }

    // Track spending — the quote comes from the 402 requirements
    // ($0.002 x batch size).
    this.sessionCalls++;
    const paidUsd = Number(details.amount) / 1_000_000; // USDC has 6 decimals
    if (Number.isFinite(paidUsd)) this.sessionTotalUsd += paidUsd;

    return { data: await retryResponse.json(), headers: retryResponse.headers };
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

  getWalletAddress(): string {
    return this.account.address;
  }

  getSpending(): Spending {
    return { totalUsd: this.sessionTotalUsd, calls: this.sessionCalls };
  }
}

export default RpcClient;
