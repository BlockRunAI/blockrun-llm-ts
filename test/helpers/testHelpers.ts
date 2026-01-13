/**
 * Test utilities and mock builders for BlockRun LLM SDK tests.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";

/**
 * Test private key (DO NOT use in production).
 * This is a well-known test key from Hardhat/Foundry.
 */
export const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/**
 * Test account derived from TEST_PRIVATE_KEY.
 * Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 */
export const TEST_ACCOUNT: Account = privateKeyToAccount(TEST_PRIVATE_KEY);

/**
 * Test recipient address for payment mocks.
 */
export const TEST_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

/**
 * Build a mock 402 Payment Required response.
 */
export function buildPaymentRequiredResponse(overrides?: {
  amount?: string;
  recipient?: string;
  network?: string;
  resource?: { url: string; description: string };
}): string {
  const paymentRequired = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: overrides?.network || "eip155:8453",
        amount: overrides?.amount || "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: overrides?.recipient || TEST_RECIPIENT,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
    resource: overrides?.resource || {
      url: "https://api.blockrun.ai/v1/chat/completions",
      description: "BlockRun AI API call",
    },
  };

  return btoa(JSON.stringify(paymentRequired));
}

/**
 * Build a mock successful chat response.
 */
export function buildChatResponse(overrides?: {
  content?: string;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}) {
  return {
    id: "chatcmpl-test123",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: overrides?.model || "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: overrides?.content || "This is a test response.",
        },
        finish_reason: "stop" as const,
      },
    ],
    usage: {
      prompt_tokens: overrides?.usage?.prompt_tokens || 10,
      completion_tokens: overrides?.usage?.completion_tokens || 20,
      total_tokens: (overrides?.usage?.prompt_tokens || 10) + (overrides?.usage?.completion_tokens || 20),
    },
  };
}

/**
 * Build a mock error response.
 */
export function buildErrorResponse(overrides?: {
  error?: string;
  status?: number;
  internal_data?: string;
}) {
  return {
    error: overrides?.error || "Test error message",
    code: "test_error",
    // These should be filtered out by sanitization
    internal_stack: overrides?.internal_data || "/var/app/handler.js:123",
    api_key: "secret_key_should_be_filtered",
  };
}

/**
 * Build a mock models list response.
 */
export function buildModelsResponse() {
  return {
    data: [
      {
        id: "openai/gpt-4o",
        provider: "openai",
        name: "GPT-4o",
        inputPrice: 2.5,
        outputPrice: 10.0,
      },
      {
        id: "anthropic/claude-sonnet-4.5",
        provider: "anthropic",
        name: "Claude Sonnet 4.5",
        inputPrice: 3.0,
        outputPrice: 15.0,
      },
      {
        id: "google/gemini-2.5-flash",
        provider: "google",
        name: "Gemini 2.5 Flash",
        inputPrice: 0.15,
        outputPrice: 0.6,
      },
    ],
  };
}

/**
 * Mock fetch responses for testing.
 */
export class MockFetchResponse {
  constructor(
    private body: unknown,
    private init: { status: number; headers?: Record<string, string> }
  ) {}

  get status() {
    return this.init.status;
  }

  get ok() {
    return this.init.status >= 200 && this.init.status < 300;
  }

  headers = {
    get: (name: string) => this.init.headers?.[name] || null,
  };

  async json() {
    return this.body;
  }

  async text() {
    return typeof this.body === "string" ? this.body : JSON.stringify(this.body);
  }
}

/**
 * Create a mock fetch function that returns specific responses.
 */
export function createMockFetch(responses: {
  [url: string]: {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  };
}) {
  return async (url: string | URL, init?: RequestInit) => {
    const urlString = typeof url === "string" ? url : url.toString();
    const response = responses[urlString];

    if (!response) {
      throw new Error(`No mock response configured for URL: ${urlString}`);
    }

    return new MockFetchResponse(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
}

/**
 * Wait for a specified number of milliseconds.
 * Useful for integration tests that need delays between requests.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a mock image models list response.
 */
export function buildImageModelsResponse() {
  return {
    data: [
      {
        id: "google/nano-banana",
        provider: "google",
        name: "Nano Banana",
        pricePerImage: 0.01,
        supportedSizes: ["1024x1024", "512x512"],
        available: true,
      },
      {
        id: "openai/dall-e-3",
        provider: "openai",
        name: "DALL-E 3",
        pricePerImage: 0.04,
        supportedSizes: ["1024x1024", "1792x1024", "1024x1792"],
        available: true,
      },
    ],
  };
}

/**
 * Build a mock image generation response.
 */
export function buildImageResponse(overrides?: {
  url?: string;
  revisedPrompt?: string;
}) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: [
      {
        url: overrides?.url || "https://example.com/generated-image.png",
        revised_prompt: overrides?.revisedPrompt,
      },
    ],
  };
}
