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
  // Extended fields returned by reasoning-capable upstream providers
  // (DeepSeek Reasoner, Grok 4 / 4.20 reasoning, xAI multi-agent).
  // Backend strips these from inbound requests but may forward them on the
  // response side, so they are accepted as optional here.
  reasoning_content?: string;
  thinking?: string;
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
  num_sources_used?: number; // Live Search sources used
  // Anthropic prompt caching — populated on anthropic/* models when cache
  // headers are sent. Reads are cheaper; writes incur a one-time surcharge.
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
  citations?: string[]; // Live Search citation URLs

  /**
   * Populated when the gateway transparently substituted a different
   * model for the one the caller asked for — typically because the
   * requested model errored and the gateway routed to a free fallback
   * to fulfil the request. When `used` is true:
   *   - `model` is the model that actually answered (vs `ChatResponse.model`
   *     which historically reflected the requested model id).
   *   - `settlementSkipped` is `true` when the gateway also skipped the
   *     on-chain settle — i.e. the user was not charged for this call
   *     because a free fallback served it.
   * Surfaced from the gateway's `X-Fallback-Used / X-Fallback-Model /
   * X-Settlement-Skipped` response headers. Absent when the headers
   * aren't present (most calls).
   */
  fallback?: {
    used: true;
    model?: string;
    settlementSkipped?: boolean;
  };
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  description: string;
  /** Per 1M tokens. 0 when billingMode !== "paid". */
  inputPrice: number;
  /** Per 1M tokens. 0 when billingMode !== "paid". */
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  categories: string[];
  available: boolean;
  type?: "llm" | "image"; // For listAllModels()
  /** One of "paid" (per-token), "flat" (flatPrice per request) or "free". */
  billingMode?: "paid" | "flat" | "free";
  /** Flat per-request price when billingMode === "flat". */
  flatPrice?: number;
  /** True for deprecated/superseded models that remain routable. */
  hidden?: boolean;
}

// Image generation types
export interface ImageData {
  url: string;
  /** Original upstream URL (e.g. imgen.x.ai). Omitted for data URIs. */
  source_url?: string;
  /** True when the gateway mirrored the image to its GCS bucket. Omitted for data URIs. */
  backed_up?: boolean;
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

// Live Search types
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

/** Usage info for Live Search sources */
export interface SearchUsage {
  /** Number of search sources used in the response */
  numSourcesUsed?: number;
}

// Spending tracking
export interface Spending {
  totalUsd: number;
  calls: number;
}

/** Pre-request cost estimate for a chat call */
export interface CostEstimate {
  /** Model ID used for the estimate */
  model: string;
  /** Estimated input token count */
  estimatedInputTokens: number;
  /** Estimated output token count */
  estimatedOutputTokens: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
}

/** Per-call spending report with running session totals */
export interface SpendingReport {
  /** Model ID used */
  model: string;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens consumed */
  outputTokens: number;
  /** Cost of this call in USD */
  costUsd: number;
  /** Cumulative session spend in USD */
  sessionTotalUsd: number;
  /** Total number of calls in this session */
  sessionCalls: number;
}

/** Chat response bundled with its spending report */
export interface ChatResponseWithCost {
  /** The chat completion response */
  response: ChatResponse;
  /** Spending report for this call */
  spendingReport: SpendingReport;
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
  /** Enable Live Search (shortcut for searchParameters.mode = "on") */
  search?: boolean;
  /** Full Live Search configuration (for search-enabled models) */
  searchParameters?: SearchParameters;
  /**
   * Models to try in order if the primary returns a transient error
   * (timeout, network, 5xx). 4xx and PaymentError still propagate
   * immediately. `smartChat` populates this from the routing tier's
   * fallback chain automatically.
   */
  fallbackModels?: string[];
}

export interface ChatCompletionOptions {
  /** Max tokens to generate */
  maxTokens?: number;
  /** Sampling temperature */
  temperature?: number;
  /** Nucleus sampling parameter */
  topP?: number;
  /** Enable Live Search (shortcut for searchParameters.mode = "on") */
  search?: boolean;
  /** Full Live Search configuration (for search-enabled models) */
  searchParameters?: SearchParameters;
  /** Tool definitions for function calling */
  tools?: Tool[];
  /** Tool selection strategy */
  toolChoice?: ToolChoice;
  /**
   * Models to try in order if the primary returns a transient error
   * (timeout, network, 5xx). 4xx and PaymentError still propagate
   * immediately.
   */
  fallbackModels?: string[];
}

// Smart routing types (ClawRouter integration)
export type RoutingProfile = "eco" | "auto" | "premium";

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
  /** Routing profile applied by clawrouter (may include "agentic" on gateway responses). */
  profile?: RoutingProfile | "agentic";
  /** Score used when agentic routing is active. */
  agenticScore?: number;
  /**
   * Remaining tier models with known pricing, in fallback order. `chat()`
   * walks this list when the primary model hits a transient error
   * (timeout, network, 5xx). Excludes the primary itself.
   */
  fallbacks?: string[];
}

export interface SmartChatOptions extends ChatOptions {
  /** Routing profile: eco (budget), auto (balanced), premium (best quality) */
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

// Music / Audio types

export interface AudioTrack {
  url: string;
  duration_seconds?: number;
  lyrics?: string;
}

export interface MusicResponse {
  created: number;
  model: string;
  data: AudioTrack[];
  txHash?: string;
}

export interface AudioModel {
  id: string;
  name: string;
  provider: string;
  description: string;
  pricePerTrack: number;
  maxDurationSeconds: number;
  supportsLyrics: boolean;
  supportsInstrumental: boolean;
  available: boolean;
  type: "audio";
}

export interface MusicClientOptions {
  /** EVM wallet private key (hex string starting with 0x) */
  privateKey?: `0x${string}` | string;
  /** API endpoint URL (default: https://blockrun.ai/api) */
  apiUrl?: string;
  /** Request timeout in milliseconds (default: 210000 — music gen takes 1-3 min) */
  timeout?: number;
}

export interface MusicGenerateOptions {
  /** Model ID (default: "minimax/music-2.5+") */
  model?: "minimax/music-2.5+" | "minimax/music-2.5";
  /** Generate without vocals (default: true) */
  instrumental?: boolean;
  /** Custom lyrics — cannot be used with instrumental: true */
  lyrics?: string;
}

// Video types

export interface VideoClip {
  /** Permanent blockrun-hosted URL (falls back to upstream if backup fails) */
  url: string;
  /** Original upstream URL (e.g. vidgen.x.ai) */
  source_url?: string;
  /** Duration of the generated video */
  duration_seconds?: number;
  /** Upstream provider's request id (xAI) */
  request_id?: string;
  /** True when the gateway mirrored the video to its GCS bucket */
  backed_up?: boolean;
}

export interface VideoResponse {
  created: number;
  model: string;
  data: VideoClip[];
  txHash?: string;
}

export interface VideoModel {
  id: string;
  name: string;
  provider: string;
  description: string;
  pricePerSecond: number;
  defaultDurationSeconds: number;
  maxDurationSeconds: number;
  supportsImageInput: boolean;
  available: boolean;
  type: "video";
}

export interface VideoClientOptions {
  /** EVM wallet private key (hex string starting with 0x) */
  privateKey?: `0x${string}` | string;
  /** API endpoint URL (default: https://blockrun.ai/api) */
  apiUrl?: string;
  /** Request timeout in milliseconds (default: 300000 — video gen + polling up to 3 min) */
  timeout?: number;
}

export interface VideoGenerateOptions {
  /** Model ID (default: "xai/grok-imagine-video") */
  model?: "xai/grok-imagine-video" | string;
  /** Optional seed image URL for image-to-video */
  imageUrl?: string;
  /** Duration to bill for (defaults to model's default duration) */
  durationSeconds?: number;
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

// =============================================================================
// Exa Web Search Types
// =============================================================================

export interface ExaSearchOptions {
  /** Number of results to return (default: 10, max: 100) */
  numResults?: number;
  /** Restrict to a content category */
  category?: "github" | "news" | "research paper" | "linkedin profile" | "personal site" | "tweet" | "financial report" | "pdf" | "company";
  /** Only include pages published after this date (ISO 8601) */
  startPublishedDate?: string;
  /** Only include pages published before this date (ISO 8601) */
  endPublishedDate?: string;
  /** Only search within these domains */
  includeDomains?: string[];
  /** Exclude these domains from results */
  excludeDomains?: string[];
}

export interface ExaSearchItem {
  id: string;
  url: string;
  title: string;
  publishedDate?: string;
  author?: string;
  score?: number;
}

export interface ExaSearchResponse {
  requestId: string;
  resolvedSearchType: string;
  results: ExaSearchItem[];
  searchTime: number;
  costDollars: { total: number };
}

export interface ExaAnswerCitation {
  id: string;
  title: string;
  url: string;
  publishedDate?: string;
  favicon?: string;
}

export interface ExaAnswerResponse {
  requestId: string;
  answer: string;
  citations: ExaAnswerCitation[];
}

export interface ExaContentItem {
  id: string;
  url: string;
  title: string;
  text: string;
  author?: string | null;
}

export interface ExaContentsResponse {
  results: ExaContentItem[];
  costDollars: { total: number };
}

export interface ExaFindSimilarOptions {
  /** Number of results to return (default: 10, max: 100) */
  numResults?: number;
  /** Exclude pages from the same domain as the reference URL */
  excludeSourceDomain?: boolean;
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

// Pyth-backed market-data types (crypto/fx/commodity/usstock/stocks).

export type PriceCategory = "crypto" | "fx" | "commodity" | "usstock" | "stocks";
export type StockMarket =
  | "us" | "hk" | "jp" | "kr" | "gb" | "de"
  | "fr" | "nl" | "ie" | "lu" | "cn" | "ca";
export type BarResolution = "1" | "5" | "15" | "60" | "240" | "D" | "W" | "M";
export type MarketSession = "pre" | "post" | "on";

export interface PricePoint {
  symbol: string;
  price: number;
  publishTime?: number; // unix seconds
  confidence?: number;
  feedId?: string;
  timestamp?: string;
  assetType?: string;
  category?: string;
  source?: string;
  free?: boolean;
}

export interface PriceBar {
  t?: number; // bar open (unix seconds)
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

export interface PriceHistoryResponse {
  symbol: string;
  resolution?: string;
  from?: number;
  to?: number;
  bars: PriceBar[];
  source?: string;
  category?: string;
}

export interface SymbolListResponse {
  symbols: Array<Record<string, unknown>>;
  count?: number;
}

export interface PriceOptions {
  /** Required when category === "stocks". */
  market?: StockMarket;
  /** Optional US-equity session hint; ignored for non-equity. */
  session?: MarketSession;
}

export interface HistoryOptions extends PriceOptions {
  /** TradingView-style bar resolution. Defaults to "D". */
  resolution?: BarResolution;
  /** Window start, unix seconds (required). */
  from: number;
  /** Window end, unix seconds. Defaults to now on the backend. */
  to?: number;
}

export interface ListOptions extends PriceOptions {
  /** Free-text filter (maps to ?q=). */
  query?: string;
  /** Page size, capped at 2000. Defaults to 100. */
  limit?: number;
}

// Client option bags for the new standalone clients.

export interface SearchClientOptions {
  privateKey?: `0x${string}` | string;
  apiUrl?: string;
  timeout?: number;
}

export interface XClientOptions {
  privateKey?: `0x${string}` | string;
  apiUrl?: string;
  timeout?: number;
}

export interface PriceClientOptions {
  privateKey?: `0x${string}` | string;
  apiUrl?: string;
  timeout?: number;
  /** If false, construction succeeds without a wallet (free endpoints only). */
  requireWallet?: boolean;
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
