/**
 * BlockRun LLM Client - Main SDK entry point.
 *
 * Usage:
 *   import { LLMClient } from '@blockrun/llm';
 *
 *   // Option 1: Use BASE_CHAIN_WALLET_KEY env var
 *   const client = new LLMClient();
 *
 *   // Option 2: Pass private key directly
 *   const client = new LLMClient({ privateKey: '0x...' });
 *
 *   const response = await client.chat('openai/gpt-4o', 'Hello!');
 *   console.log(response);
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import {
  type ChatMessage,
  type ChatResponse,
  type ChatOptions,
  type ChatCompletionOptions,
  type LLMClientOptions,
  type Model,
  type ImageModel,
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
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT = 60000;

/**
 * BlockRun LLM Gateway Client.
 *
 * Provides access to multiple LLM providers (OpenAI, Anthropic, Google, etc.)
 * with automatic x402 micropayments on Base chain.
 */
export class LLMClient {
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;

  /**
   * Initialize the BlockRun LLM client.
   *
   * @param options - Client configuration options (optional if BASE_CHAIN_WALLET_KEY env var is set)
   */
  constructor(options: LLMClientOptions = {}) {
    // Get private key from options or environment variable (browser-safe check)
    const envKey = typeof process !== "undefined" && process.env
      ? process.env.BASE_CHAIN_WALLET_KEY
      : undefined;
    const privateKey = options.privateKey || envKey;

    if (!privateKey) {
      throw new Error(
        "Private key required. Pass privateKey in options or set BASE_CHAIN_WALLET_KEY environment variable."
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
   * Simple 1-line chat interface.
   *
   * @param model - Model ID (e.g., 'openai/gpt-4o', 'anthropic/claude-sonnet-4')
   * @param prompt - User message
   * @param options - Optional chat parameters
   * @returns Assistant's response text
   *
   * @example
   * const response = await client.chat('gpt-4o', 'What is the capital of France?');
   * console.log(response); // 'The capital of France is Paris.'
   */
  async chat(model: string, prompt: string, options?: ChatOptions): Promise<string> {
    const messages: ChatMessage[] = [];

    if (options?.system) {
      messages.push({ role: "system", content: options.system });
    }

    messages.push({ role: "user", content: prompt });

    const result = await this.chatCompletion(model, messages, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      topP: options?.topP,
      search: options?.search,
      searchParameters: options?.searchParameters,
    });

    return result.choices[0].message.content;
  }

  /**
   * Full chat completion interface (OpenAI-compatible).
   *
   * @param model - Model ID
   * @param messages - Array of messages with role and content
   * @param options - Optional completion parameters
   * @returns ChatResponse object with choices and usage
   */
  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    options?: ChatCompletionOptions
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options?.maxTokens || DEFAULT_MAX_TOKENS,
    };

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options?.topP !== undefined) {
      body.top_p = options.topP;
    }

    // Handle xAI Live Search parameters
    if (options?.searchParameters !== undefined) {
      body.search_parameters = options.searchParameters;
    } else if (options?.search === true) {
      // Simple shortcut: search=true enables live search with defaults
      body.search_parameters = { mode: "on" };
    }

    return this.requestWithPayment("/v1/chat/completions", body);
  }

  /**
   * Make a request with automatic x402 payment handling.
   */
  private async requestWithPayment(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<ChatResponse> {
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

    return response.json() as Promise<ChatResponse>;
  }

  /**
   * Handle 402 response: parse requirements, sign payment, retry.
   */
  private async handlePaymentAndRetry(
    url: string,
    body: Record<string, unknown>,
    response: Response
  ): Promise<ChatResponse> {
    // Get payment required header (x402 library uses lowercase)
    let paymentHeader = response.headers.get("payment-required");

    if (!paymentHeader) {
      // Try to get from response body
      try {
        const respBody = await response.json() as Record<string, unknown>;
        if (respBody.x402 || respBody.accepts) {
          paymentHeader = btoa(JSON.stringify(respBody));
        }
      } catch (parseError) {
        // Log for debugging but don't expose to user
        console.debug("Failed to parse payment header from response body", parseError);
      }
    }

    if (!paymentHeader) {
      throw new PaymentError("402 response but no payment requirements found");
    }

    // Parse payment requirements
    const paymentRequired = parsePaymentRequired(paymentHeader);

    // Extract payment details
    const details = extractPaymentDetails(paymentRequired);

    // Create signed payment payload (v2 format)
    // Pass through extensions from server (for Bazaar discovery)
    const extensions = ((paymentRequired as unknown) as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
    const paymentPayload = await createPaymentPayload(
      this.privateKey,
      this.account.address,
      details.recipient,
      details.amount,
      details.network || "eip155:8453",
      {
        resourceUrl: validateResourceUrl(
          details.resource?.url || `${this.apiUrl}/v1/chat/completions`,
          this.apiUrl
        ),
        resourceDescription: details.resource?.description || "BlockRun AI API call",
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
        extensions,
      }
    );

    // Retry with payment (x402 library expects PAYMENT-SIGNATURE header)
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
      throw new PaymentError("Payment was rejected. Check your wallet balance.");
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

    // Update session spending
    const costUsd = parseFloat(details.amount) / 1e6; // Convert from micro USDC
    this.sessionCalls += 1;
    this.sessionTotalUsd += costUsd;

    return retryResponse.json() as Promise<ChatResponse>;
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
   * List available LLM models with pricing.
   */
  async listModels(): Promise<Model[]> {
    const response = await this.fetchWithTimeout(`${this.apiUrl}/v1/models`, {
      method: "GET",
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { error: "Request failed" };
      }
      throw new APIError(
        `Failed to list models: ${response.status}`,
        response.status,
        sanitizeErrorResponse(errorBody)
      );
    }

    const data = (await response.json()) as { data?: Model[] };
    return data.data || [];
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
   * List all available models (both LLM and image) with pricing.
   *
   * @returns Array of all models with 'type' field ('llm' or 'image')
   *
   * @example
   * const models = await client.listAllModels();
   * for (const model of models) {
   *   if (model.type === 'llm') {
   *     console.log(`LLM: ${model.id} - $${model.inputPrice}/M input`);
   *   } else {
   *     console.log(`Image: ${model.id} - $${model.pricePerImage}/image`);
   *   }
   * }
   */
  async listAllModels(): Promise<(Model | ImageModel)[]> {
    // Get LLM models
    const llmModels = await this.listModels();
    for (const model of llmModels) {
      model.type = "llm";
    }

    // Get image models
    const imageModels = await this.listImageModels();
    for (const model of imageModels) {
      model.type = "image";
    }

    return [...llmModels, ...imageModels];
  }

  /**
   * Get current session spending.
   *
   * @returns Object with totalUsd and calls count
   *
   * @example
   * const spending = client.getSpending();
   * console.log(`Spent $${spending.totalUsd.toFixed(4)} across ${spending.calls} calls`);
   */
  getSpending(): Spending {
    return {
      totalUsd: this.sessionTotalUsd,
      calls: this.sessionCalls,
    };
  }

  /**
   * Get the wallet address being used for payments.
   */
  getWalletAddress(): string {
    return this.account.address;
  }
}

export default LLMClient;
