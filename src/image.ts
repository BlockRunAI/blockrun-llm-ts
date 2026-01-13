/**
 * BlockRun Image Client - Generate images via x402 micropayments.
 *
 * SECURITY NOTE - Private Key Handling:
 * Your private key NEVER leaves your machine. Here's what happens:
 * 1. Key stays local - only used to sign an EIP-712 typed data message
 * 2. Only the SIGNATURE is sent in the PAYMENT-SIGNATURE header
 * 3. BlockRun verifies the signature on-chain via Coinbase CDP facilitator
 *
 * Usage:
 *   import { ImageClient } from '@blockrun/llm';
 *
 *   const client = new ImageClient({ privateKey: '0x...' });
 *   const result = await client.generate('A cute cat in space');
 *   console.log(result.data[0].url);
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type ImageClientOptions,
  type ImageResponse,
  type ImageModel,
  type ImageGenerateOptions,
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
  validateResourceUrl,
} from "./validation";

const DEFAULT_API_URL = "https://blockrun.ai/api";
const DEFAULT_MODEL = "google/nano-banana";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_TIMEOUT = 120000; // Images take longer

/**
 * BlockRun Image Generation Client.
 *
 * Generate images using Nano Banana (Google Gemini), DALL-E 3, or GPT Image
 * with automatic x402 micropayments on Base chain.
 */
export class ImageClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;

  /**
   * Initialize the BlockRun Image client.
   *
   * @param options - Client configuration options
   */
  constructor(options: ImageClientOptions = {}) {
    // Get private key from options or environment variable
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

    // Validate private key format
    validatePrivateKey(privateKey);

    // Store private key for signing (never transmitted)
    this.privateKey = privateKey as `0x${string}`;

    // Initialize wallet account (key stays local, never transmitted)
    this.account = privateKeyToAccount(privateKey as `0x${string}`);

    // Validate and set API URL
    const apiUrl = options.apiUrl || DEFAULT_API_URL;
    validateApiUrl(apiUrl);
    this.apiUrl = apiUrl.replace(/\/$/, "");

    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  /**
   * Generate an image from a text prompt.
   *
   * @param prompt - Text description of the image to generate
   * @param options - Optional generation parameters
   * @returns ImageResponse with generated image URLs
   *
   * @example
   * const result = await client.generate('A sunset over mountains');
   * console.log(result.data[0].url);
   */
  async generate(
    prompt: string,
    options?: ImageGenerateOptions
  ): Promise<ImageResponse> {
    const body: Record<string, unknown> = {
      model: options?.model || DEFAULT_MODEL,
      prompt,
      size: options?.size || DEFAULT_SIZE,
      n: options?.n || 1,
    };

    if (options?.quality) {
      body.quality = options.quality;
    }

    return this.requestWithPayment("/v1/images/generations", body);
  }

  /**
   * List available image generation models with pricing.
   */
  async listImageModels(): Promise<ImageModel[]> {
    const response = await this.fetchWithTimeout(
      `${this.apiUrl}/v1/images/models`,
      { method: "GET" }
    );

    if (!response.ok) {
      throw new APIError(
        `Failed to list image models: ${response.status}`,
        response.status
      );
    }

    const data = (await response.json()) as { data?: ImageModel[] };
    return data.data || [];
  }

  /**
   * Make a request with automatic x402 payment handling.
   */
  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<ImageResponse> {
    const url = `${this.apiUrl}${endpoint}`;

    // First attempt (will likely return 402)
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Handle 402 Payment Required
    if (response.status === 402) {
      return this.handlePaymentAndRetry(url, body, response);
    }

    // Handle other errors
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

    return response.json() as Promise<ImageResponse>;
  }

  /**
   * Handle 402 response: parse requirements, sign payment, retry.
   */
  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<ImageResponse> {
    // Get payment required header
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      try {
        const respBody = (await response.json()) as Record<string, unknown>;
        if (respBody.x402 || respBody.accepts) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch {
        // Ignore parse errors
      }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    // Parse payment requirements
    const paymentRequired = parsePaymentRequired(paymentHeader);

    // Extract payment details
    const details = extractPaymentDetails(paymentRequired);

    // Create signed payment payload
    const extensions = (paymentRequired as unknown as Record<string, unknown>)
      .extensions as Record<string, unknown> | undefined;
    const paymentPayload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || `${this.apiUrl}/v1/images/generations`,
          this.apiUrl
        ),
        resourceDescription:
          details.resource?.description || "BlockRun Image Generation",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
        extensions,
      }
    );

    // Retry with payment
    const retryResponse = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentPayload,
      },
      body: JSON.stringify(body),
    });

    // Check for errors
    if (retryResponse.status === 402) {
      throw new PaymentError(
        "Payment was rejected. Check your wallet balance."
      );
    }

    if (!retryResponse.ok) {
      let errorBody: unknown;
      try {
        errorBody = await retryResponse.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `API error after payment: ${retryResponse.status}`,
        retryResponse.status,
        sanitizeErrorResponse(errorBody)
      );
    }

    return retryResponse.json() as Promise<ImageResponse>;
  }

  /**
   * Fetch with timeout.
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get the wallet address being used for payments.
   */
  getWalletAddress(): string {
    return this.account.address;
  }

  /**
   * Get session spending information.
   */
  getSpending(): Spending {
    return {
      totalUsd: this.sessionTotalUsd,
      calls: this.sessionCalls,
    };
  }
}

export default ImageClient;
