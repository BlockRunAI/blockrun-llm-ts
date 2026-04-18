/**
 * BlockRun Video Client - Generate short AI videos via x402 micropayments.
 *
 * SECURITY NOTE - Private Key Handling:
 * Your private key NEVER leaves your machine. Here's what happens:
 * 1. Key stays local - only used to sign an EIP-712 typed data message
 * 2. Only the SIGNATURE is sent in the PAYMENT-SIGNATURE header
 * 3. BlockRun verifies the signature on-chain via Coinbase CDP facilitator
 *
 * Usage:
 *   import { VideoClient } from '@blockrun/llm';
 *
 *   const client = new VideoClient({ privateKey: '0x...' });
 *   const result = await client.generate('a red apple slowly spinning on a wooden table');
 *   console.log(result.data[0].url);            // permanent MP4 URL
 *   console.log(result.data[0].duration_seconds); // 8
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type VideoClientOptions,
  type VideoResponse,
  type VideoGenerateOptions,
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
const DEFAULT_MODEL = "xai/grok-imagine-video";
const DEFAULT_TIMEOUT = 300_000; // video gen + polling up to 3 min

/**
 * BlockRun Video Generation Client.
 *
 * Generates 8-second MP4 clips using xAI's Grok Imagine Video with
 * automatic x402 micropayments on Base chain.
 *
 * Pricing: $0.05/second (default 8s -> $0.42/clip with margin).
 * Returned URLs are permanent (mirrored to BlockRun storage).
 */
export class VideoClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;

  constructor(options: VideoClientOptions = {}) {
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
   * Generate a short video clip from a text prompt (or text + image).
   *
   * Blocks until the video is ready (30-120s typical).
   *
   * @param prompt - Text description of the video
   * @param options - Optional generation parameters
   * @returns VideoResponse with the clip URL, duration, and upstream request_id
   *
   * @example Text-to-video
   * const result = await client.generate('a hummingbird hovering near a red flower');
   * console.log(result.data[0].url);
   *
   * @example Image-to-video
   * const result = await client.generate('the subject turns and smiles', {
   *   imageUrl: 'https://example.com/portrait.jpg',
   * });
   */
  async generate(
    prompt: string,
    options?: VideoGenerateOptions
  ): Promise<VideoResponse> {
    const body: Record<string, unknown> = {
      model: options?.model || DEFAULT_MODEL,
      prompt,
    };
    if (options?.imageUrl) body.image_url = options.imageUrl;
    if (options?.durationSeconds !== undefined) body.duration_seconds = options.durationSeconds;

    return this.requestWithPayment("/v1/videos/generations", body);
  }

  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<VideoResponse> {
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

    return response.json() as Promise<VideoResponse>;
  }

  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<VideoResponse> {
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
        resourceUrl: details.resource?.url || `${this.apiUrl}/v1/videos/generations`,
        resourceDescription: details.resource?.description || "BlockRun Video Generation",
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

    const data = (await retryResponse.json()) as VideoResponse;

    // Track spending (best-effort estimate based on default 8s duration)
    const billedSeconds = typeof body.duration_seconds === "number" ? body.duration_seconds : 8;
    this.sessionCalls++;
    this.sessionTotalUsd += 0.05 * billedSeconds * 1.05;

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

export default VideoClient;
