/**
 * BlockRun Voice Call Client - AI-powered outbound phone calls via x402 micropayments.
 *
 * The AI agent calls a phone number (E.164) and conducts a real-time conversation
 * based on your 'task' instructions. STT, LLM, and TTS are handled upstream by
 * Bland.ai; BlockRun handles billing through x402.
 *
 * SECURITY NOTE - Private Key Handling:
 * Your private key NEVER leaves your machine. Here's what happens:
 * 1. Key stays local - only used to sign an EIP-712 typed data message
 * 2. Only the SIGNATURE is sent in the PAYMENT-SIGNATURE header
 * 3. BlockRun verifies the signature on-chain via Coinbase CDP facilitator
 *
 * Usage:
 *   import { VoiceClient } from '@blockrun/llm';
 *
 *   const client = new VoiceClient({ privateKey: '0x...' });
 *
 *   // Initiate a call (paid, $0.54)
 *   const result = await client.call({
 *     to: '+14155552671',
 *     task: 'You are a friendly assistant calling to confirm a 3pm dentist appointment.',
 *     max_duration: 5,
 *   });
 *   console.log(result.call_id);
 *
 *   // Poll status, transcript, recording (free)
 *   const status = await client.getStatus(result.call_id);
 *   console.log(status);
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type VoiceClientOptions,
  type CallOptions,
  type CallInitiatedResponse,
  type CallStatusResponse,
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
const DEFAULT_TIMEOUT = 60_000; // initiation returns quickly
const CALL_PRICE_USD = 0.54;
const VALID_MODELS = new Set(["base", "enhanced", "turbo"]);

/**
 * BlockRun Voice Call Client.
 *
 * Initiates AI-powered outbound phone calls with automatic x402 micropayments
 * on Base chain.
 *
 * Pricing: $0.54 per call (regardless of duration up to max_duration).
 * Status polling is free.
 */
export class VoiceClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;

  constructor(options: VoiceClientOptions = {}) {
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
   * Initiate an AI-powered outbound phone call.
   *
   * Pricing: $0.54 per call. Returns immediately once the call is queued —
   * poll getStatus() for transcript and recording.
   *
   * @example
   *   const r = await client.call({
   *     to: '+14155552671',
   *     task: 'Confirm the user wants to reschedule to Tuesday 2pm.',
   *     voice: 'maya',
   *     max_duration: 3,
   *   });
   */
  async call(options: CallOptions): Promise<CallInitiatedResponse> {
    if (!options.to || !options.to.trim()) {
      throw new Error("'to' phone number is required (E.164 format)");
    }
    const task = options.task?.trim() ?? "";
    if (task.length < 10) {
      throw new Error("'task' must be at least 10 characters");
    }
    if (task.length > 4000) {
      throw new Error("'task' must be at most 4000 characters");
    }
    const maxDuration = options.max_duration ?? 5;
    if (maxDuration < 1 || maxDuration > 30) {
      throw new Error("max_duration must be between 1 and 30 minutes");
    }
    if (options.model && !VALID_MODELS.has(options.model)) {
      throw new Error("model must be 'base' | 'enhanced' | 'turbo'");
    }
    if (
      options.interruption_threshold !== undefined &&
      (options.interruption_threshold < 50 || options.interruption_threshold > 500)
    ) {
      throw new Error("interruption_threshold must be between 50 and 500");
    }

    const body: Record<string, unknown> = {
      to: options.to.trim(),
      task,
      max_duration: maxDuration,
      language: options.language ?? "en-US",
    };
    if (options.from) body.from = options.from.trim();
    if (options.voice) body.voice = options.voice;
    if (options.first_sentence) body.first_sentence = options.first_sentence.trim();
    if (options.wait_for_greeting !== undefined) body.wait_for_greeting = options.wait_for_greeting;
    if (options.interruption_threshold !== undefined) body.interruption_threshold = options.interruption_threshold;
    if (options.model) body.model = options.model;

    return this.requestWithPayment("/v1/voice/call", body);
  }

  /**
   * Poll the status of an in-progress or completed call. Free — no payment.
   *
   * Returns Bland.ai's full call record: status, transcript, recording URL, etc.
   * Most fields populate only once the call ends.
   */
  async getStatus(callId: string): Promise<CallStatusResponse> {
    if (!callId || !callId.trim()) {
      throw new Error("callId is required");
    }
    const url = `${this.apiUrl}/v1/voice/call/${encodeURIComponent(callId.trim())}`;
    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (response.status === 404) {
      throw new APIError(`Call not found: ${callId}`, 404, { call_id: callId });
    }
    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
    }

    return response.json() as Promise<CallStatusResponse>;
  }

  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<CallInitiatedResponse> {
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

    return response.json() as Promise<CallInitiatedResponse>;
  }

  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<CallInitiatedResponse> {
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
        resourceUrl: details.resource?.url || `${this.apiUrl}/v1/voice/call`,
        resourceDescription: details.resource?.description || "BlockRun Voice Call",
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

    const data = (await retryResponse.json()) as CallInitiatedResponse;

    this.sessionCalls++;
    this.sessionTotalUsd += CALL_PRICE_USD;

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

export default VoiceClient;
