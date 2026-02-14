/**
 * Type definitions for BlockRun LLM SDK
 */

// Tool calling types (OpenAI compatible)
export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface Tool {
  type: "function";
  function: FunctionDefinition;
}

export interface FunctionCall {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: FunctionCall;
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string; // For tool messages
  tool_call_id?: string; // For tool result messages
  tool_calls?: ToolCall[]; // For assistant messages with tool calls
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason?: "stop" | "length" | "content_filter" | "tool_calls";
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
  /** Tool definitions for function calling */
  tools?: Tool[];
  /** Tool selection strategy */
  toolChoice?: ToolChoice;
}

// Smart routing types (ClawRouter integration)
export type RoutingProfile = "free" | "eco" | "auto" | "premium";

export type RoutingTier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

export interface RoutingDecision {
  model: string;
  tier: RoutingTier;
  confidence: number;
  method: "rules" | "llm";
  reasoning: string;
  costEstimate: number;
  baselineCost: number;
  savings: number; // 0-1 percentage
}

export interface SmartChatOptions extends ChatOptions {
  /** Routing profile: free (zero cost), eco (budget), auto (balanced), premium (best quality) */
  routingProfile?: RoutingProfile;
  /** Maximum output tokens (used for cost estimation) */
  maxOutputTokens?: number;
}

export interface SmartChatResponse {
  /** The AI response text */
  response: string;
  /** Which model was selected by smart routing */
  model: string;
  /** Routing decision metadata */
  routing: RoutingDecision;
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
