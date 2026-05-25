/**
 * BlockRun Portrait Client — enroll a Virtual Portrait via x402.
 *
 * Wraps `POST /v1/portrait/enroll` ($0.01 USDC promo, no KYC). You upload a face image
 * by URL and get back a Token360 asset id (`ta_xxxxxx`). Pass that id as
 * `realFaceAssetId` on a Seedance 2.0 video generation (VideoClient.generate)
 * to keep the same AI character across clips.
 *
 * SECURITY NOTE — your private key never leaves your machine. Only EIP-712
 * signatures are sent in the PAYMENT-SIGNATURE header.
 *
 * @example
 *   import { PortraitClient, VideoClient } from '@blockrun/llm';
 *
 *   const portraits = new PortraitClient({ privateKey: '0x...' });
 *   const { asset_id } = await portraits.enroll({
 *     name: 'Spokesperson',
 *     imageUrl: 'https://example.com/face.jpg',
 *   });
 *
 *   const video = new VideoClient({ privateKey: '0x...' });
 *   const clip = await video.generate('she waves and smiles', {
 *     model: 'bytedance/seedance-2.0-fast',
 *     realFaceAssetId: asset_id,
 *   });
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type PortraitClientOptions,
  type PortraitEnrollOptions,
  type PortraitEnrollResponse,
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

/**
 * Flat enrollment price in USD — mirrors the backend's `ENROLLMENT_PRICE_USD`.
 * Currently $0.01 (promotional, parity with RealFace). The authoritative price
 * is whatever the gateway quotes in the 402; this constant is informational.
 */
export const PORTRAIT_ENROLLMENT_PRICE_USD = 0.01;

/**
 * BlockRun Portrait Client.
 *
 * Enrolls a Virtual Portrait from a face image URL and returns the `ta_xxxxxx`
 * asset id consumed by Seedance 2.0 video generation. Real-person likeness is
 * not supported on BlockRun — enrolled portraits are AI characters.
 */
export class PortraitClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd = 0;
  private sessionCalls = 0;

  constructor(options: PortraitClientOptions = {}) {
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

  /** EVM wallet address used for payments. */
  getWalletAddress(): string {
    return this.account.address;
  }

  /** Session-cumulative USD spend + call count across this client instance. */
  getSpending(): Spending {
    return { totalUsd: this.sessionTotalUsd, calls: this.sessionCalls };
  }

  /**
   * Enroll a Virtual Portrait from a face image URL. $0.01 (promo).
   *
   * Payment is settled only after Token360 confirms the enrollment, so failed
   * enrollments never charge your wallet.
   *
   * @param options.name     Display name (1–64 chars).
   * @param options.imageUrl Public HTTPS URL to a JPG/PNG/WEBP image (≤10 MB).
   * @returns The enrollment record, including `asset_id` (`ta_xxxxxx`).
   */
  async enroll(options: PortraitEnrollOptions): Promise<PortraitEnrollResponse> {
    const name = typeof options?.name === "string" ? options.name.trim() : "";
    if (name.length < 1 || name.length > 64) {
      throw new Error("name is required and must be 1–64 characters");
    }
    const imageUrl =
      typeof options?.imageUrl === "string" ? options.imageUrl.trim() : "";
    if (!/^https?:\/\//i.test(imageUrl)) {
      throw new Error(
        "imageUrl must be a public http(s) URL to a JPG/PNG/WEBP image"
      );
    }

    const data = await this.request<Record<string, unknown>>({
      name,
      image_url: imageUrl,
    });
    return data as unknown as PortraitEnrollResponse;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async request<T>(body: Record<string, unknown>): Promise<T> {
    const url = `${this.apiUrl}/v1/portrait/enroll`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.status === 402) {
      return this.handlePaymentAndRetry<T>(url, body, response);
    }
    return this.unwrap<T>(response, false);
  }

  private async handlePaymentAndRetry<T>(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<T> {
    let paymentHeader = response.headers.get("payment-required");
    if (!paymentHeader) {
      try {
        const rb = (await response.json()) as Record<string, unknown>;
        if (rb.x402 || rb.accepts) paymentHeader = btoa(JSON.stringify(rb));
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
        resourceDescription:
          details.resource?.description || "BlockRun Virtual Portrait",
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
    const data = await this.unwrap<Record<string, unknown>>(retry, true);

    const costUsd = Number.parseFloat(details.amount) / 1e6;
    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;

    // The enroll route returns the on-chain settlement hash in the body
    // (`settlement.tx_hash`), not a receipt header. Surface it as a flat
    // `txHash` for parity with other client responses.
    if (data && typeof data === "object" && !("txHash" in data)) {
      const settlement = (data as Record<string, unknown>).settlement as
        | { tx_hash?: string | null }
        | undefined;
      if (settlement?.tx_hash) {
        (data as Record<string, unknown>).txHash = settlement.tx_hash;
      }
    }
    return data as unknown as T;
  }

  private async unwrap<T>(response: Response, afterPayment: boolean): Promise<T> {
    if (response.ok) {
      return response.json() as Promise<T>;
    }
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = { error: "Request failed" };
    }
    const prefix = afterPayment ? "API error after payment" : "API error";
    throw new APIError(
      `${prefix}: ${response.status}`,
      response.status,
      sanitizeErrorResponse(errorBody)
    );
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

export default PortraitClient;
