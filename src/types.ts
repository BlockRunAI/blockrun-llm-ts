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
  categories: string[];
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

// Standalone search result
export interface SearchResult {
  query: string;
  summary: string;
  citations?: Array<Record<string, string>>;
  sources_used?: number;
  model?: string;
}

// Image editing options
export interface ImageEditOptions {
  /** Model ID (default: "openai/gpt-image-1") */
  model?: string;
  /** Optional base64-encoded mask image */
  mask?: string;
  /** Image size (default: "1024x1024") */
  size?: string;
  /** Number of images to generate (default: 1) */
  n?: number;
}

// Search options for standalone search endpoint
export interface SearchOptions {
  /** Source types to search (e.g. ["web", "x", "news"]) */
  sources?: string[];
  /** Maximum number of results (default: 10) */
  maxResults?: number;
  /** Start date filter (YYYY-MM-DD) */
  fromDate?: string;
  /** End date filter (YYYY-MM-DD) */
  toDate?: string;
}

// X/Twitter types (powered by AttentionVC)
export interface XUser {
  id: string;
  userName: string;
  name: string;
  profilePicture?: string;
  description?: string;
  followers?: number;
  following?: number;
  isBlueVerified?: boolean;
  verifiedType?: string;
  location?: string;
  joined?: string;
}

export interface XUserLookupResponse {
  users: XUser[];
  not_found?: string[];
  total_requested?: number;
  total_found?: number;
}

export interface XFollower {
  id: string;
  name?: string;
  screen_name?: string;
  userName?: string;
  location?: string;
  description?: string;
  protected?: boolean;
  verified?: boolean;
  followers_count?: number;
  following_count?: number;
  favourites_count?: number;
  statuses_count?: number;
  created_at?: string;
  profile_image_url_https?: string;
  can_dm?: boolean;
}

export interface XFollowersResponse {
  followers: XFollower[];
  has_next_page?: boolean;
  next_cursor?: string;
  total_returned?: number;
  username?: string;
}

export interface XFollowingsResponse {
  followings: XFollower[];
  has_next_page?: boolean;
  next_cursor?: string;
  total_returned?: number;
  username?: string;
}

export interface XUserInfoResponse {
  data: Record<string, unknown>;
  username?: string;
}

export interface XVerifiedFollowersResponse {
  followers: XFollower[];
  has_next_page?: boolean;
  next_cursor?: string;
  total_returned?: number;
}

export interface XTweet {
  id: string;
  text?: string;
  created_at?: string;
  author?: Record<string, unknown>;
  favorite_count?: number;
  retweet_count?: number;
  reply_count?: number;
  view_count?: number;
  lang?: string;
  entities?: Record<string, unknown>;
  media?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface XTweetsResponse {
  tweets: XTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
  total_returned?: number;
}

export interface XMentionsResponse {
  tweets: XTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
  total_returned?: number;
  username?: string;
}

export interface XTweetLookupResponse {
  tweets: XTweet[];
  not_found?: string[];
  total_requested?: number;
  total_found?: number;
}

export interface XTweetRepliesResponse {
  replies: XTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
  total_returned?: number;
}

export interface XTweetThreadResponse {
  tweets: XTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
  total_returned?: number;
}

export interface XSearchResponse {
  tweets: XTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
  total_returned?: number;
}

export interface XTrendingResponse {
  data: Record<string, unknown>;
}

export interface XArticlesRisingResponse {
  data: Record<string, unknown>;
}

export interface XAuthorAnalyticsResponse {
  data: Record<string, unknown>;
  handle?: string;
}

export interface XCompareAuthorsResponse {
  data: Record<string, unknown>;
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
