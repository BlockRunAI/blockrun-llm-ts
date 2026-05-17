/**
 * BlockRun Video Client - Generate short AI videos via x402 micropayments.
 *
 * SECURITY NOTE - Private Key Handling:
 * Your private key NEVER leaves your machine. Here's what happens:
 * 1. Key stays local - only used to sign an EIP-712 typed data message
 * 2. Only the SIGNATURE is sent in the PAYMENT-SIGNATURE header
 * 3. BlockRun verifies the signature on-chain via Coinbase CDP facilitator
 *
 * Async flow (client-polled):
 *   POST /v1/videos/generations         -> 402 -> sign -> 202 { id, poll_url }
 *   GET  /v1/videos/generations/{id}    -> loop until status=completed
 *
 * The client signs ONCE and replays the same PAYMENT-SIGNATURE on every poll.
 * Settlement happens only on the first completed poll, so upstream failure or
 * the caller giving up = zero charge.
 *
 * Usage:
 *   import { VideoClient } from '@blockrun/llm';
 *
 *   const client = new VideoClient({ privateKey: '0x...' });
 *   const result = await client.generate('a red apple slowly spinning on a wooden table');
 *   console.log(result.data[0].url);            // permanent MP4 URL
 *   console.log(result.data[0].duration_seconds);
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type VideoClientOptions,
  type VideoResponse,
  type VideoGenerateOptions,
  type Spending,
  type PaymentRequired,
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
// Per-HTTP-call timeout (submit or poll). Total budget for a generate() is
// `DEFAULT_GENERATE_BUDGET_MS` below, independent of this.
const DEFAULT_TIMEOUT = 120_000;
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_GENERATE_BUDGET_MS = 300_000; // 5 min upstream budget
// Advertised signed-auth window. Server default is 300s; we bump to 600s so
// the signature stays valid across the async polling window.
const MAX_TIMEOUT_SECONDS = 600;

/**
 * BlockRun Video Generation Client.
 *
 * Supports xAI Grok Imagine Video and ByteDance Seedance (1.5 Pro /
 * 2.0 Fast / 2.0 Pro) with automatic x402 micropayments on Base.
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
   * Submits an async job, then polls until the video is ready. Typical total
   * wall-time is 60-180s. If upstream runs past the budget (default 5min),
   * throws without charging.
   *
   * @param prompt - Text description of the video
   * @param options - Optional generation parameters
   */
  async generate(
    prompt: string,
    options?: VideoGenerateOptions & { budgetMs?: number }
  ): Promise<VideoResponse> {
    const body: Record<string, unknown> = {
      model: options?.model || DEFAULT_MODEL,
      prompt,
    };
    if (options?.imageUrl) body.image_url = options.imageUrl;
    if (options?.durationSeconds !== undefined) body.duration_seconds = options.durationSeconds;
    // ── Token360 / Seedance passthroughs (gateway silently ignores for xAI) ─
    if (options?.aspectRatio) body.aspect_ratio = options.aspectRatio;
    if (options?.resolution) body.resolution = options.resolution;
    if (options?.generateAudio !== undefined) body.generate_audio = options.generateAudio;
    if (options?.seed !== undefined) body.seed = options.seed;
    if (options?.watermark !== undefined) body.watermark = options.watermark;
    if (options?.returnLastFrame) body.return_last_frame = true;

    const budgetMs = options?.budgetMs ?? DEFAULT_GENERATE_BUDGET_MS;
    return this.submitAndPoll(body, budgetMs);
  }

  // --------------------------------------------------------------------
  // Internal: async submit + poll
  // --------------------------------------------------------------------

  private async submitAndPoll(
    body: Record<string, unknown>,
    budgetMs: number
  ): Promise<VideoResponse> {
    const submitUrl = `${this.apiUrl}/v1/videos/generations`;

    // Step 1: 402 with payment requirements
    const resp402 = await this.fetchWithTimeout(submitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp402.status !== 402) {
      await this.throwApiError(resp402, "Expected 402 on first POST");
    }

    const paymentRequired = await this.extractPaymentRequired(resp402);
    const details = extractPaymentDetails(paymentRequired);

    const paymentPayload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: details.resource?.url || submitUrl,
        resourceDescription: details.resource?.description || "BlockRun Video Generation",
        // Ensure signed auth covers the entire polling window.
        maxTimeoutSeconds: Math.max(details.maxTimeoutSeconds || 0, MAX_TIMEOUT_SECONDS),
        extra: details.extra,
      }
    );

    // Step 2: submit with payment -> 202 { id, poll_url }
    const submitResp = await this.fetchWithTimeout(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body),
    });

    if (submitResp.status === 402) {
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
    }
    if (submitResp.status !== 200 && submitResp.status !== 202) {
      await this.throwApiError(submitResp, "Submit failed");
    }

    const submitData = (await submitResp.json()) as {
      id?: string;
      poll_url?: string;
      status?: string;
    };
    if (!submitData.id || !submitData.poll_url) {
      throw new APIError(
        "Submit response missing id/poll_url",
        submitResp.status,
        { response: submitData }
      );
    }

    const pollUrl = this.absolute(submitData.poll_url);

    // Step 3: poll with the same PAYMENT-SIGNATURE until completed
    const deadline = Date.now() + budgetMs;
    let lastStatus = submitData.status || "queued";

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

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

      if (pollResp.status === 202 && (lastStatus === "queued" || lastStatus === "in_progress")) {
        continue;
      }

      if (lastStatus === "failed") {
        throw new APIError(
          `Upstream generation failed: ${(pollData.error as string) || "unknown"}`,
          pollResp.status,
          sanitizeErrorResponse(pollData)
        );
      }

      if (pollResp.status === 200 && lastStatus === "completed") {
        const data = pollData as unknown as VideoResponse;
        const billedSeconds =
          typeof body.duration_seconds === "number" ? body.duration_seconds : 8;
        this.sessionCalls++;
        this.sessionTotalUsd += 0.05 * billedSeconds * 1.05;
        const txHash =
          pollResp.headers.get("x-payment-receipt") ||
          pollResp.headers.get("X-Payment-Receipt");
        if (txHash) data.txHash = txHash;
        return data;
      }

      if (pollResp.status !== 200 && pollResp.status !== 202 && pollResp.status !== 504) {
        await this.throwApiError(pollResp, "Poll failed");
      }
      // 504 on poll = transient upstream hiccup; retry
    }

    throw new APIError(
      `Video generation did not complete within ${Math.round(budgetMs / 1000)}s ` +
        `(last status: ${lastStatus}). No payment was taken.`,
      504,
      { id: submitData.id, last_status: lastStatus }
    );
  }

  private absolute(url: string): string {
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    const base = this.apiUrl.endsWith("/api")
      ? this.apiUrl.slice(0, -"/api".length)
      : this.apiUrl;
    return `${base}${url}`;
  }

  private async extractPaymentRequired(resp: Response): Promise<PaymentRequired> {
    const header = resp.headers.get("payment-required");
    if (header) return parsePaymentRequired(header);
    try {
      const body = (await resp.json()) as Record<string, unknown>;
      if (body && (body.x402Version !== undefined || body.accepts !== undefined)) {
        return body as unknown as PaymentRequired;
      }
    } catch {
      /* fall through */
    }
    throw new PaymentError("402 response but no payment requirements found");
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
