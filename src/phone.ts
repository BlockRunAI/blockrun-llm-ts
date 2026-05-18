/**
 * BlockRun Phone Client — Twilio-backed phone lookup + number provisioning via x402.
 *
 * Endpoints (all under /v1/phone/...):
 *   POST /lookup            $0.01    Carrier + line-type lookup
 *   POST /lookup/fraud      $0.05    Carrier + SIM-swap / call-forwarding signals
 *   POST /numbers/buy       $5.00    Provision a US/CA number (30-day lease, bound to wallet)
 *   POST /numbers/renew     $5.00    Extend an existing number by 30 days
 *   POST /numbers/list      $0.001   List the wallet's active numbers
 *   POST /numbers/release   free     Release a provisioned number (still flows through x402
 *                                    so the backend can verify wallet identity)
 *
 * After buying a number you can use it as the `from` caller ID in VoiceClient.call().
 *
 * SECURITY NOTE — your private key never leaves your machine. Only EIP-712
 * signatures are sent in the PAYMENT-SIGNATURE header.
 *
 * @example
 *   import { PhoneClient } from '@blockrun/llm';
 *
 *   const client = new PhoneClient({ privateKey: '0x...' });
 *
 *   // Lookup a number
 *   const info = await client.lookup('+14155552671');
 *
 *   // Buy a number (US, optional area code)
 *   const bought = await client.buyNumber({ country: 'US', areaCode: '415' });
 *   console.log(bought.phone_number, bought.expires_at);
 *
 *   // List your active numbers
 *   console.log(await client.listNumbers());
 *
 *   // Renew / release
 *   await client.renewNumber(bought.phone_number);
 *   await client.releaseNumber(bought.phone_number);
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type PhoneClientOptions,
  type PhoneLookupResponse,
  type PhoneBuyOptions,
  type PhoneBuyResponse,
  type PhoneRenewResponse,
  type PhoneListResponse,
  type PhoneReleaseResponse,
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

/** Per-endpoint price in USD — mirrors the backend's `PHONE_PRICES`. */
export const PHONE_PRICES: Readonly<Record<string, number>> = Object.freeze({
  lookup: 0.01,
  "lookup/fraud": 0.05,
  "numbers/buy": 5.0,
  "numbers/renew": 5.0,
  "numbers/list": 0.001,
  "numbers/release": 0.0,
});

function requireE164(value: string | undefined | null): string {
  if (!value || typeof value !== "string") {
    throw new Error("phoneNumber is required (E.164 format, e.g. '+14155552671')");
  }
  const v = value.trim();
  if (!/^\+\d{7,15}$/.test(v)) {
    throw new Error(
      `phoneNumber must be E.164 (e.g. '+14155552671'), got ${JSON.stringify(value)}`
    );
  }
  return v;
}

/**
 * BlockRun Phone Client.
 *
 * Wraps the `/v1/phone/*` x402 endpoints — phone-number lookup (carrier + fraud)
 * and provisioning of the caller-ID numbers required by VoiceClient.call().
 */
export class PhoneClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd = 0;
  private sessionCalls = 0;

  constructor(options: PhoneClientOptions = {}) {
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

  // ─── Lookup ────────────────────────────────────────────────────────────

  /**
   * Carrier + line-type lookup. ~$0.01.
   *
   * @param phoneNumber E.164 number (e.g. "+14155552671").
   */
  async lookup(phoneNumber: string): Promise<PhoneLookupResponse> {
    const num = requireE164(phoneNumber);
    return this.request("lookup", { phoneNumber: num });
  }

  /**
   * Lookup + fraud signals (SIM swap, call forwarding). ~$0.05.
   *
   * @param phoneNumber E.164 number.
   */
  async lookupFraud(phoneNumber: string): Promise<PhoneLookupResponse> {
    const num = requireE164(phoneNumber);
    return this.request("lookup/fraud", { phoneNumber: num });
  }

  // ─── Provisioning ──────────────────────────────────────────────────────

  /**
   * Provision a dedicated phone number for 30 days. $5.00.
   *
   * Payment is settled only after Twilio confirms the purchase, so failed
   * buys never charge your wallet.
   *
   * @param options.country  ISO country code, "US" or "CA" (default "US").
   * @param options.areaCode Optional 3-digit area-code hint. Availability is
   *   not guaranteed — the backend falls back to any number in the country if
   *   the area code can't be matched.
   */
  async buyNumber(options: PhoneBuyOptions = {}): Promise<PhoneBuyResponse> {
    const country = options.country ?? "US";
    if (country !== "US" && country !== "CA") {
      throw new Error("country must be 'US' or 'CA'");
    }
    const body: Record<string, unknown> = { country };
    if (options.areaCode !== undefined) {
      const ac = options.areaCode;
      if (typeof ac !== "string" || !/^\d{3}$/.test(ac)) {
        throw new Error("areaCode must be a 3-digit string, e.g. '415'");
      }
      body.areaCode = ac;
    }
    const data = await this.request<Record<string, unknown>>("numbers/buy", body);
    return data as unknown as PhoneBuyResponse;
  }

  /**
   * Extend an existing provisioned number by 30 days. $5.00.
   *
   * @throws {APIError} 403 when the wallet doesn't own the number or it has expired.
   */
  async renewNumber(phoneNumber: string): Promise<PhoneRenewResponse> {
    const num = requireE164(phoneNumber);
    const data = await this.request<Record<string, unknown>>("numbers/renew", {
      phoneNumber: num,
    });
    return data as unknown as PhoneRenewResponse;
  }

  /** List the wallet's active phone numbers. ~$0.001. */
  async listNumbers(): Promise<PhoneListResponse> {
    const data = await this.request<Record<string, unknown>>("numbers/list", {});
    return data as unknown as PhoneListResponse;
  }

  /**
   * Release a provisioned number back to the Twilio pool. Free, but still
   * flows through x402 so the backend can verify ownership.
   */
  async releaseNumber(phoneNumber: string): Promise<PhoneReleaseResponse> {
    const num = requireE164(phoneNumber);
    const data = await this.request<Record<string, unknown>>("numbers/release", {
      phoneNumber: num,
    });
    return data as unknown as PhoneReleaseResponse;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.apiUrl}/v1/phone/${path}`;
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
        resourceDescription: details.resource?.description || "BlockRun Phone",
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

    const txHash =
      retry.headers.get("x-payment-receipt") ||
      retry.headers.get("X-Payment-Receipt");
    if (txHash && data && typeof data === "object" && !("txHash" in data)) {
      (data as Record<string, unknown>).txHash = txHash;
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

export default PhoneClient;
