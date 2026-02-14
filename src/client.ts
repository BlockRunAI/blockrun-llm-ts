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
  type SmartChatOptions,
  type SmartChatResponse,
  type RoutingDecision,
  APIError,
  PaymentError,
} from "./types";
import { route, DEFAULT_ROUTING_CONFIG } from "@blockrun/clawrouter";

// Model pricing type for ClawRouter (matches @blockrun/clawrouter internal type)
type ModelPricing = {
  inputPrice: number;  // per 1M tokens
  outputPrice: number; // per 1M tokens
};
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
const TESTNET_API_URL = "https://testnet.blockrun.ai/api";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT = 60000;

// SDK version for User-Agent header (client identification in server logs)
const SDK_VERSION = "0.3.0";
const USER_AGENT = `blockrun-ts/${SDK_VERSION}`;

/**
 * BlockRun LLM Gateway Client.
 *
 * Provides access to multiple LLM providers (OpenAI, Anthropic, Google, etc.)
 * with automatic x402 micropayments on Base chain.
 *
 * Networks:
 * - Mainnet: https://blockrun.ai/api (Base, Chain ID 8453)
 * - Testnet: https://testnet.blockrun.ai/api (Base Sepolia, Chain ID 84532)
 *
 * @example Testnet usage
 * ```ts
 * // Use testnet convenience function
 * import { testnetClient } from '@blockrun/llm';
 * const client = testnetClient({ privateKey: '0x...' });
 * const response = await client.chat('openai/gpt-oss-20b', 'Hello!');
 *
 * // Or configure manually
 * const client = new LLMClient({
 *   privateKey: '0x...',
 *   apiUrl: 'https://testnet.blockrun.ai/api'
 * });
 * ```
 */
export class LLMClient {
  static readonly DEFAULT_API_URL = DEFAULT_API_URL;
  static readonly TESTNET_API_URL = TESTNET_API_URL;
  private account: Account;
  private privateKey: `0x${string}`;
  private apiUrl: string;
  private timeout: number;
  private sessionTotalUsd: number = 0;
  private sessionCalls: number = 0;
  private modelPricingCache: Map<string, ModelPricing> | null = null;
  private modelPricingPromise: Promise<Map<string, ModelPricing>> | null = null;

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

    return result.choices[0].message.content || "";
  }

  /**
   * Smart chat with automatic model routing.
   *
   * Uses ClawRouter's 14-dimension rule-based scoring algorithm (<1ms, 100% local)
   * to select the cheapest model that can handle your request.
   *
   * @param prompt - User message
   * @param options - Optional chat and routing parameters
   * @returns SmartChatResponse with response text, selected model, and routing metadata
   *
   * @example Simple usage (auto profile)
   * ```ts
   * const result = await client.smartChat('What is 2+2?');
   * console.log(result.response); // '4'
   * console.log(result.model); // 'google/gemini-2.5-flash'
   * console.log(result.routing.savings); // 0.78 (78% savings)
   * ```
   *
   * @example With routing profile
   * ```ts
   * // Free tier only (zero cost)
   * const result = await client.smartChat('Hello!', { routingProfile: 'free' });
   *
   * // Eco mode (budget optimized)
   * const result = await client.smartChat('Explain quantum computing', { routingProfile: 'eco' });
   *
   * // Premium mode (best quality)
   * const result = await client.smartChat('Write a business plan', { routingProfile: 'premium' });
   * ```
   */
  async smartChat(prompt: string, options?: SmartChatOptions): Promise<SmartChatResponse> {
    // Get model pricing (cached after first call)
    const modelPricing = await this.getModelPricing();

    // Determine max output tokens for cost estimation
    const maxOutputTokens = options?.maxOutputTokens || options?.maxTokens || 1024;

    // Route the request using ClawRouter
    const decision = route(prompt, options?.system, maxOutputTokens, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing,
      routingProfile: options?.routingProfile,
    });

    // Make the chat request with the selected model
    const response = await this.chat(decision.model, prompt, {
      system: options?.system,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      topP: options?.topP,
      search: options?.search,
      searchParameters: options?.searchParameters,
    });

    return {
      response,
      model: decision.model,
      routing: decision as RoutingDecision,
    };
  }

  /**
   * Get model pricing map (cached).
   * Fetches from API on first call, then returns cached result.
   */
  private async getModelPricing(): Promise<Map<string, ModelPricing>> {
    // Return cached pricing if available
    if (this.modelPricingCache) {
      return this.modelPricingCache;
    }

    // If already fetching, wait for that promise
    if (this.modelPricingPromise) {
      return this.modelPricingPromise;
    }

    // Fetch and cache
    this.modelPricingPromise = this.fetchModelPricing();
    try {
      this.modelPricingCache = await this.modelPricingPromise;
      return this.modelPricingCache;
    } finally {
      this.modelPricingPromise = null;
    }
  }

  /**
   * Fetch model pricing from API.
   */
  private async fetchModelPricing(): Promise<Map<string, ModelPricing>> {
    const models = await this.listModels();
    const pricing = new Map<string, ModelPricing>();

    for (const model of models) {
      pricing.set(model.id, {
        inputPrice: model.inputPrice,
        outputPrice: model.outputPrice,
      });
    }

    return pricing;
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

    // Handle tool calling
    if (options?.tools !== undefined) {
      body.tools = options.tools;
    }
    if (options?.toolChoice !== undefined) {
      body.tool_choice = options.toolChoice;
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
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
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
        "User-Agent": USER_AGENT,
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

  /**
   * Check if client is configured for testnet.
   */
  isTestnet(): boolean {
    return this.apiUrl.includes("testnet.blockrun.ai");
  }
}

/**
 * Create a testnet LLM client for development and testing.
 *
 * This is a convenience function that creates an LLMClient configured
 * for the BlockRun testnet (Base Sepolia).
 *
 * @param options - Client options (privateKey required unless BASE_CHAIN_WALLET_KEY env var is set)
 * @returns LLMClient configured for testnet
 *
 * @example
 * ```ts
 * import { testnetClient } from '@blockrun/llm';
 *
 * const client = testnetClient({ privateKey: '0x...' });
 * const response = await client.chat('openai/gpt-oss-20b', 'Hello!');
 * ```
 *
 * Testnet Setup:
 * 1. Get testnet ETH from https://www.alchemy.com/faucets/base-sepolia
 * 2. Get testnet USDC from https://faucet.circle.com/
 * 3. Use your wallet with testnet funds
 *
 * Available Testnet Models:
 * - openai/gpt-oss-20b
 * - openai/gpt-oss-120b
 */
export function testnetClient(options: Omit<LLMClientOptions, 'apiUrl'> = {}): LLMClient {
  return new LLMClient({
    ...options,
    apiUrl: TESTNET_API_URL,
  });
}

export default LLMClient;
