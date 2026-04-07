/**
 * BlockRun Music Client - Generate music tracks via x402 micropayments.
 *
 * SECURITY NOTE - Private Key Handling:
 * Your private key NEVER leaves your machine. Here's what happens:
 * 1. Key stays local - only used to sign an EIP-712 typed data message
 * 2. Only the SIGNATURE is sent in the PAYMENT-SIGNATURE header
 * 3. BlockRun verifies the signature on-chain via Coinbase CDP facilitator
 *
 * Usage:
 *   import { MusicClient } from '@blockrun/llm';
 *
 *   const client = new MusicClient({ privateKey: '0x...' });
 *   const result = await client.generate('upbeat synthwave with neon pads');
 *   console.log(result.data[0].url); // CDN URL — download within 24h
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type MusicClientOptions,
  type MusicResponse,
  type MusicGenerateOptions,
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
const DEFAULT_MODEL = "minimax/music-2.5+";
const DEFAULT_TIMEOUT = 210_000; // music gen takes 1-3 min

/**
 * BlockRun Music Generation Client.
 *
 * Generate full-length ~3 minute music tracks using MiniMax Music 2.5+
 * with automatic x402 micropayments on Base chain.
 *
 * Pricing: $0.1575/track
 * Note: Generated URLs expire in ~24h — download immediately if needed.
 */
export class MusicClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;

  constructor(options: MusicClientOptions = {}) {
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
   * Generate a music track from a text prompt.
   *
   * Takes 1-3 minutes. Returns a CDN URL valid for ~24h.
   *
   * @param prompt - Music style, mood, or description
   * @param options - Optional generation parameters
   * @returns MusicResponse with track URL and metadata
   *
   * @example
   * const result = await client.generate('chill lo-fi beats with piano');
   * console.log(result.data[0].url); // Download this URL — expires in 24h
   *
   * @example With lyrics
   * const result = await client.generate('upbeat pop song', {
   *   instrumental: false,
   *   lyrics: 'Hello world, this is my song...'
   * });
   */
  async generate(
    prompt: string,
    options?: MusicGenerateOptions
  ): Promise<MusicResponse> {
    const instrumental = options?.instrumental ?? true;
    const lyrics = options?.lyrics?.trim();

    if (instrumental && lyrics) {
      throw new Error("Cannot specify lyrics when instrumental is true");
    }

    const body: Record<string, unknown> = {
      model: options?.model || DEFAULT_MODEL,
      prompt,
      instrumental,
    };
    if (lyrics) body.lyrics = lyrics;

    return this.requestWithPayment("/v1/audio/generations", body);
  }

  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<MusicResponse> {
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
      try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
    }

    return response.json() as Promise<MusicResponse>;
  }

  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<MusicResponse> {
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
        resourceUrl: details.resource?.url || `${this.apiUrl}/v1/audio/generations`,
        resourceDescription: details.resource?.description || "BlockRun Music Generation",
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

    const data = await retryResponse.json() as MusicResponse;

    // Track spending
    this.sessionCalls++;
    this.sessionTotalUsd += 0.1575;

    // Attach tx hash from response header if present
    const txHash = retryResponse.headers.get("x-payment-receipt") || retryResponse.headers.get("X-Payment-Receipt");
    if (txHash) data.txHash = txHash;

    return data;
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

export default MusicClient;
