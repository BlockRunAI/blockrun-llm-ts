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
 * The client signs once and replays the same PAYMENT-SIGNATURE on every poll,
 * re-signing automatically if the 600s authorization window lapses mid-poll.
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
// 15 min: generation itself is 1-3 min, but the upstream pipeline can lag the
// status read-path several minutes behind actual completion (observed: video
// done in 100s, status flipped ~7.5min later). Jobs stay claimable ~48h, so a
// patient default beats a premature give-up.
const DEFAULT_GENERATE_BUDGET_MS = 900_000;
// Advertised signed-auth window. Server default is 300s; we bump to 600s so
// the signature stays valid across the async polling window. Budgets longer
// than this window are handled by re-signing mid-poll (see submitAndPoll).
const MAX_TIMEOUT_SECONDS = 600;
// Max mid-poll re-signs after a 402 (signature expiry). A fresh signature
// that 402s again means a genuine payment problem, not expiry.
const MAX_POLL_RESIGNS = 2;

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
   * wall-time is 60-180s, but upstream status can lag several minutes behind
   * actual completion. If upstream runs past the budget (default 15min),
   * throws without charging — the job stays claimable ~48h via poll_url.
   *
   * @param prompt - Text description of the video
   * @param options - Optional generation parameters
   */
  async generate(
    prompt: string,
    options?: VideoGenerateOptions & { budgetMs?: number }
  ): Promise<VideoResponse> {
    if (options?.imageUrl && options?.realFaceAssetId) {
      throw new Error(
        "imageUrl and realFaceAssetId are mutually exclusive; pass at most one."
      );
    }
    if (options?.realFaceAssetId && !/^ta_[A-Za-z0-9]+$/.test(options.realFaceAssetId)) {
      throw new Error(
        "realFaceAssetId must be a Token360 asset id matching 'ta_[A-Za-z0-9]+' (e.g. 'ta_abc123xyz')"
      );
    }
    if (options?.lastFrameUrl && !options?.imageUrl) {
      throw new Error(
        "lastFrameUrl requires imageUrl: imageUrl seeds the FIRST frame and lastFrameUrl the FINAL frame — send both."
      );
    }
    if (options?.lastFrameUrl && options?.realFaceAssetId) {
      throw new Error(
        "lastFrameUrl and realFaceAssetId are mutually exclusive; first-and-last-frame uses imageUrl + lastFrameUrl."
      );
    }
    if (options?.referenceImageUrls?.length) {
      if (options.imageUrl || options.lastFrameUrl || options.realFaceAssetId) {
        throw new Error(
          "referenceImageUrls is mutually exclusive with imageUrl, lastFrameUrl, and realFaceAssetId."
        );
      }
      if (options.referenceImageUrls.length > 9) {
        throw new Error("referenceImageUrls accepts at most 9 images.");
      }
    }

    const body: Record<string, unknown> = {
      model: options?.model || DEFAULT_MODEL,
      prompt,
    };
    if (options?.imageUrl) body.image_url = options.imageUrl;
    if (options?.lastFrameUrl) body.last_frame_url = options.lastFrameUrl;
    if (options?.referenceImageUrls?.length) body.reference_image_urls = options.referenceImageUrls;
    if (options?.realFaceAssetId) body.real_face_asset_id = options.realFaceAssetId;
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

  /**
   * Generate a video from a standard Seedance `content[]` body.
   *
   * Targets the gateway's `POST /v1/videos` endpoint, which accepts the
   * mainstream multimodal `content` array (text + a single reference image)
   * used by other Seedance APIs — so callers already holding a
   * `content[]`-shaped request can submit it unchanged. The gateway validates
   * unsupported inputs *before* charging, then delegates to the same x402
   * submit+poll pipeline as {@link generate}.
   *
   * Most SDK users should prefer {@link generate} (structured options like
   * `imageUrl` / `lastFrameUrl`) — this exists for migrating existing
   * `content[]` payloads with no reshaping.
   *
   * @param content - The Seedance `content` array, e.g.
   *   `[{ type: "text", text: "a red apple spinning" }]` or a text item plus
   *   `{ type: "image_url", image_url: { url: "https://..." } }`.
   * @param options - `model`, `budgetMs`, plus the same camelCase render options
   *   as {@link generate} (`durationSeconds`, `aspectRatio`, `resolution`,
   *   `generateAudio`, `seed`, `watermark`, `returnLastFrame`). These are mapped
   *   to the gateway's snake_case fields for you. Any other keys you pass are
   *   forwarded verbatim (use snake_case for those, since the gateway reads
   *   snake_case only).
   */
  async generateFromContent(
    content: Array<Record<string, unknown>>,
    options?: {
      model?: string;
      budgetMs?: number;
      durationSeconds?: number;
      aspectRatio?: string;
      resolution?: string;
      generateAudio?: boolean;
      seed?: number;
      watermark?: boolean;
      returnLastFrame?: boolean;
    } & Record<string, unknown>
  ): Promise<VideoResponse> {
    if (!Array.isArray(content) || content.length === 0) {
      throw new Error("content must be a non-empty array of Seedance content items.");
    }

    const {
      model,
      budgetMs,
      durationSeconds,
      aspectRatio,
      resolution,
      generateAudio,
      seed,
      watermark,
      returnLastFrame,
      ...extra
    } = options ?? {};

    // Spread unknown keys FIRST so the validated positional `content` (and the
    // mapped options below) always win — a stray `content`/`model` inside
    // options can't clobber the real arguments. Then map the known camelCase
    // render options to the snake_case the gateway actually reads (matches
    // generate()); these take precedence over any snake_case passed in extra.
    const body: Record<string, unknown> = { ...extra, content };
    if (model !== undefined) body.model = model;
    if (durationSeconds !== undefined) body.duration_seconds = durationSeconds;
    if (aspectRatio !== undefined) body.aspect_ratio = aspectRatio;
    if (resolution !== undefined) body.resolution = resolution;
    if (generateAudio !== undefined) body.generate_audio = generateAudio;
    if (seed !== undefined) body.seed = seed;
    if (watermark !== undefined) body.watermark = watermark;
    if (returnLastFrame !== undefined) body.return_last_frame = returnLastFrame;

    return this.submitAndPoll(body, budgetMs ?? DEFAULT_GENERATE_BUDGET_MS, "/v1/videos");
  }

  // --------------------------------------------------------------------
  // Internal: async submit + poll
  // --------------------------------------------------------------------

  private async submitAndPoll(
    body: Record<string, unknown>,
    budgetMs: number,
    submitPath: string = "/v1/videos/generations"
  ): Promise<VideoResponse> {
    const submitUrl = `${this.apiUrl}${submitPath}`;

    // Step 1: 402 with payment requirements
    const resp402 = await this.fetchWithTimeout(submitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp402.status !== 402) {
      await this.throwApiError(resp402, "Expected 402 on first POST");
    }

    let { payload: paymentPayload, details } = await this.signFromChallenge(
      resp402,
      submitUrl
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

    // Step 3: poll with the same PAYMENT-SIGNATURE until completed. The
    // signed authorization is valid for MAX_TIMEOUT_SECONDS (600s); when a
    // poll 402s after that window, we fetch a fresh challenge from the same
    // poll_url and re-sign with the same wallet — the gateway enforces wallet
    // binding, not signature equality, so a fresh signature is accepted.
    const deadline = Date.now() + budgetMs;
    let lastStatus = submitData.status || "queued";
    let resignsLeft = MAX_POLL_RESIGNS;

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

      // Terminal success is keyed on status, NOT the HTTP code — the gateway
      // settles the moment a poll reports completed, so coupling success to a
      // literal 200 would spin to the deadline (and report "not charged") on a
      // completed-but-non-200 poll the caller was already charged for.
      if (lastStatus === "completed") {
        const data = pollData as unknown as VideoResponse;
        // Account the actual settled amount (micro-USDC from the signed 402),
        // not a hardcoded per-second rate. Seedance is flat-token priced, so
        // the old xAI $0.05/sec formula misreported every non-Grok video.
        this.sessionCalls++;
        this.sessionTotalUsd += Number(details.amount) / 1e6;
        const txHash =
          pollResp.headers.get("x-payment-receipt") ||
          pollResp.headers.get("X-Payment-Receipt");
        if (txHash) data.txHash = txHash;
        return data;
      }

      if (pollResp.status === 402) {
        // Mid-poll 402 = the signed authorization expired (600s window) on a
        // budget longer than that. Re-challenge + re-sign and keep going. A
        // fresh signature that 402s again is a genuine payment problem.
        if (resignsLeft > 0) {
          resignsLeft--;
          const challenge = await this.fetchWithTimeout(pollUrl, { method: "GET" });
          if (challenge.status === 402) {
            ({ payload: paymentPayload, details } = await this.signFromChallenge(
              challenge,
              pollUrl
            ));
            continue;
          }
        }
        throw new PaymentError(
          "Payment verification failed mid-poll (not a signature-expiry). " +
            "Check the wallet balance and that you poll from the wallet that submitted the job."
        );
      }

      if (pollResp.status !== 200 && pollResp.status !== 202 && pollResp.status !== 504) {
        await this.throwApiError(pollResp, "Poll failed");
      }
      // 504 on poll = transient upstream hiccup; retry
    }

    throw new APIError(
      `Video generation did not complete within ${Math.round(budgetMs / 1000)}s ` +
        `(last status: ${lastStatus}). No payment was taken. The job is NOT lost: ` +
        `it stays claimable for ~48h — re-GET poll_url with a fresh signature from ` +
        `the same wallet to fetch (and settle) the finished video.`,
      504,
      { id: submitData.id, last_status: lastStatus, poll_url: pollUrl }
    );
  }

  /**
   * Parse an x402 challenge response and sign a payment payload for it.
   * Used for the initial submit AND for mid-poll re-signing after the 600s
   * authorization window lapses on long polls.
   */
  private async signFromChallenge(
    resp402: Response,
    fallbackUrl: string
  ): Promise<{ payload: string; details: ReturnType<typeof extractPaymentDetails> }> {
    const paymentRequired = await this.extractPaymentRequired(resp402);
    const details = extractPaymentDetails(paymentRequired);
    const payload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: details.resource?.url || fallbackUrl,
        resourceDescription: details.resource?.description || "BlockRun Video Generation",
        // Ensure signed auth covers as much of the polling window as allowed.
        maxTimeoutSeconds: Math.max(details.maxTimeoutSeconds || 0, MAX_TIMEOUT_SECONDS),
        extra: details.extra,
      }
    );
    return { payload, details };
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
