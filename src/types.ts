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
  num_sources_used?: number; // xAI Live Search sources used
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
  citations?: string[]; // xAI Live Search citation URLs
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
  type?: "llm" | "image"; // For listAllModels()
}

// Image generation types
export interface ImageData {
  url: string;
  revised_prompt?: string;
  b64_json?: string;
}

export interface ImageResponse {
  created: number;
  data: ImageData[];
}

export interface ImageModel {
  id: string;
  name: string;
  provider: string;
  description: string;
  pricePerImage: number;
  supportedSizes?: string[];
  maxPromptLength?: number;
  available: boolean;
  type?: "llm" | "image"; // For listAllModels()
}

export interface ImageClientOptions {
  /** EVM wallet private key (hex string starting with 0x) */
  privateKey?: `0x${string}` | string;
  /** API endpoint URL (default: https://blockrun.ai/api) */
  apiUrl?: string;
  /** Request timeout in milliseconds (default: 120000 for images) */
  timeout?: number;
}

export interface ImageGenerateOptions {
  /** Model ID (default: "google/nano-banana") */
  model?: string;
  /** Image size (default: "1024x1024") */
  size?: string;
  /** Number of images to generate (default: 1) */
  n?: number;
  /** Image quality (for supported models) */
  quality?: "standard" | "hd";
}

// xAI Live Search types
export interface WebSearchSource {
  type: "web";
  country?: string;
  excludedWebsites?: string[];
  allowedWebsites?: string[];
  safeSearch?: boolean;
}

export interface XSearchSource {
  type: "x";
  includedXHandles?: string[];
  excludedXHandles?: string[];
  postFavoriteCount?: number;
  postViewCount?: number;
}

export interface NewsSearchSource {
  type: "news";
  country?: string;
  excludedWebsites?: string[];
  allowedWebsites?: string[];
  safeSearch?: boolean;
}

export interface RssSearchSource {
  type: "rss";
  links: string[];
}

export type SearchSource =
  | WebSearchSource
  | XSearchSource
  | NewsSearchSource
  | RssSearchSource;

export interface SearchParameters {
  mode?: "off" | "auto" | "on";
  sources?: SearchSource[];
  returnCitations?: boolean;
  fromDate?: string; // YYYY-MM-DD format
  toDate?: string; // YYYY-MM-DD format
  maxSearchResults?: number;
}

// Spending tracking
export interface Spending {
  totalUsd: number;
  calls: number;
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
  /** EVM wallet private key (hex string starting with 0x). Optional if BASE_CHAIN_WALLET_KEY env var is set. */
  privateKey?: `0x${string}` | string;
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
  /** Enable xAI Live Search (shortcut for searchParameters.mode = "on") */
  search?: boolean;
  /** Full xAI Live Search configuration (for Grok models) */
  searchParameters?: SearchParameters;
}

export interface ChatCompletionOptions {
  /** Max tokens to generate */
  maxTokens?: number;
  /** Sampling temperature */
  temperature?: number;
  /** Nucleus sampling parameter */
  topP?: number;
  /** Enable xAI Live Search (shortcut for searchParameters.mode = "on") */
  search?: boolean;
  /** Full xAI Live Search configuration (for Grok models) */
  searchParameters?: SearchParameters;
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
