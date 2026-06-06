/**
 * BlockRun Speech Client - Text-to-speech and sound effects (ElevenLabs) via x402 micropayments.
 *
 * SECURITY NOTE - Private Key Handling:
 * Your private key NEVER leaves your machine. Here's what happens:
 * 1. Key stays local - only used to sign an EIP-712 typed data message
 * 2. Only the SIGNATURE is sent in the PAYMENT-SIGNATURE header
 * 3. BlockRun verifies the signature on-chain via Coinbase CDP facilitator
 *
 * Usage:
 *   import { SpeechClient } from '@blockrun/llm';
 *
 *   const client = new SpeechClient({ privateKey: '0x...' });
 *
 *   // Text-to-speech (price scales with character count)
 *   const result = await client.generate('Hello from BlockRun!', { voice: 'sarah' });
 *   console.log(result.data[0].url);
 *
 *   // Sound effects (flat $0.05/generation)
 *   const fx = await client.soundEffect('rain on a tin roof, distant thunder');
 *
 *   // List voices (free, rate-limited)
 *   const voices = await client.listVoices();
 *
 * Models & pricing:
 *   elevenlabs/flash-v2.5        $0.05/1k chars  ~75ms latency, 32 languages (default)
 *   elevenlabs/turbo-v2.5        $0.05/1k chars  ~250ms latency, 32 languages
 *   elevenlabs/multilingual-v2   $0.10/1k chars  long-form narration, 29 languages
 *   elevenlabs/v3                $0.10/1k chars  max expressiveness, 70+ languages
 *   elevenlabs/sound-effects     $0.05/generation (up to 22s)
 *
 * Price = (characters / 1000) x model rate, minimum $0.001/request.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type SpeechClientOptions,
  type SpeechResponse,
  type SpeechGenerateOptions,
  type SoundEffectOptions,
  type VoiceInfo,
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
const DEFAULT_MODEL = "elevenlabs/flash-v2.5";
const DEFAULT_SOUNDFX_MODEL = "elevenlabs/sound-effects";
const DEFAULT_TIMEOUT = 120_000; // synthesis is synchronous (<1s for Flash)

/**
 * BlockRun Speech Client (BlockRun Voice).
 *
 * Text-to-speech and sound-effect generation using ElevenLabs models
 * with automatic x402 micropayments on Base chain.
 *
 * TTS pricing scales with input characters; sound effects are flat
 * $0.05/generation.
 */
export class SpeechClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;

  constructor(options: SpeechClientOptions = {}) {
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
   * Synthesize speech from text (OpenAI-compatible TTS).
   *
   * Price scales with character count: (chars / 1000) x model rate,
   * minimum $0.001/request. Synthesis is synchronous.
   *
   * @param input - Text to synthesize. Per-model character caps apply
   *                (flash/turbo 40k, multilingual-v2 10k, v3 5k).
   * @param options - Optional model / voice / format / speed
   * @returns SpeechResponse with audio URL, format, and character count
   *
   * @example
   * const result = await client.generate('Welcome to BlockRun.', { voice: 'george' });
   * console.log(result.data[0].url); // audio URL (mp3 by default)
   */
  async generate(
    input: string,
    options?: SpeechGenerateOptions
  ): Promise<SpeechResponse> {
    const body: Record<string, unknown> = {
      model: options?.model || DEFAULT_MODEL,
      input,
    };
    if (options?.voice) body.voice = options.voice;
    if (options?.responseFormat) body.response_format = options.responseFormat;
    if (options?.speed !== undefined) body.speed = options.speed;

    return this.requestWithPayment("/v1/audio/speech", body);
  }

  /** OpenAI-style alias for {@link generate}. */
  speak(input: string, options?: SpeechGenerateOptions): Promise<SpeechResponse> {
    return this.generate(input, options);
  }

  /**
   * Generate a cinematic sound effect from a text prompt.
   *
   * Flat $0.05/generation, up to 22 seconds of audio.
   *
   * @param text - Sound effect description (max 1000 chars).
   *               E.g. 'rain on a tin roof', 'sci-fi door whoosh'
   * @param options - Optional duration / prompt influence / format
   * @returns SpeechResponse with audio URL and format
   *
   * @example
   * const fx = await client.soundEffect('crackling campfire at night');
   * console.log(fx.data[0].url);
   */
  async soundEffect(
    text: string,
    options?: SoundEffectOptions
  ): Promise<SpeechResponse> {
    const body: Record<string, unknown> = {
      model: options?.model || DEFAULT_SOUNDFX_MODEL,
      text,
    };
    if (options?.durationSeconds !== undefined) body.duration_seconds = options.durationSeconds;
    if (options?.promptInfluence !== undefined) body.prompt_influence = options.promptInfluence;
    if (options?.responseFormat) body.response_format = options.responseFormat;

    return this.requestWithPayment("/v1/audio/sound-effects", body);
  }

  /**
   * List available voices for TTS (free, rate-limited 60 req/min/IP).
   *
   * Pass a voice's `alias` (if present) or `voice_id` as the `voice`
   * option to {@link generate}.
   */
  async listVoices(): Promise<VoiceInfo[]> {
    const response = await this.fetchWithTimeout(`${this.apiUrl}/v1/audio/voices`, {
      method: "GET",
    });

    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await response.json(); } catch { errorBody = { error: "Request failed" }; }
      throw new APIError(`API error: ${response.status}`, response.status, sanitizeErrorResponse(errorBody));
    }

    const payload = (await response.json()) as { data?: VoiceInfo[] };
    return payload.data || [];
  }

  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<SpeechResponse> {
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

    return response.json() as Promise<SpeechResponse>;
  }

  private async handlePaymentAndRetry(
    url: string,
    endpoint: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<SpeechResponse> {
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
        resourceDescription: details.resource?.description || "BlockRun Voice",
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

    const data = await retryResponse.json() as SpeechResponse;

    // Track spending — actual price is derived server-side from the payment
    // requirements (character-scaled for TTS, flat for sound effects).
    this.sessionCalls++;
    const paidUsd = Number(details.amount) / 1_000_000; // USDC has 6 decimals
    if (Number.isFinite(paidUsd)) this.sessionTotalUsd += paidUsd;

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

export default SpeechClient;
