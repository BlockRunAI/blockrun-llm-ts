/**
 * Type definitions for BlockRun LLM SDK
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason?: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  description: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  available: boolean;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  amount?: string;
  maxAmountRequired?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: {
    name?: string;
    version?: string;
  };
}

export interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirement[];
  resource?: ResourceInfo;
}

export interface LLMClientOptions {
  /** EVM wallet private key (hex string starting with 0x) */
  privateKey: `0x${string}`;
  /** API endpoint URL (default: https://blockrun.ai/api) */
  apiUrl?: string;
  /** Request timeout in milliseconds (default: 60000) */
  timeout?: number;
}

export interface ChatOptions {
  /** System prompt */
  system?: string;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Sampling temperature */
  temperature?: number;
  /** Nucleus sampling parameter */
  topP?: number;
}

export interface ChatCompletionOptions {
  /** Max tokens to generate */
  maxTokens?: number;
  /** Sampling temperature */
  temperature?: number;
  /** Nucleus sampling parameter */
  topP?: number;
}

export class BlockrunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockrunError";
  }
}

export class PaymentError extends BlockrunError {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

export class APIError extends BlockrunError {
  statusCode: number;
  response?: unknown;

  constructor(message: string, statusCode: number, response?: unknown) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.response = response;
  }
}
