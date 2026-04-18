/**
 * BlockRun LLM SDK - Pay-per-request AI via x402 on Base
 *
 * Two ways to use:
 *
 * @example Simple API (BlockRun native)
 * import { LLMClient } from '@blockrun/llm';
 *
 * const client = new LLMClient({ privateKey: '0x...' });
 * const response = await client.chat('gpt-5.2', 'Hello!');
 * console.log(response);
 *
 * @example OpenAI-compatible API (drop-in replacement)
 * import { OpenAI } from '@blockrun/llm';
 *
 * const client = new OpenAI({ walletKey: '0x...' });
 * const response = await client.chat.completions.create({
 *   model: 'gpt-5.2',
 *   messages: [{ role: 'user', content: 'Hello!' }]
 * });
 * console.log(response.choices[0].message.content);
 *
 * @example Image generation
 * import { ImageClient } from '@blockrun/llm';
 *
 * const client = new ImageClient({ privateKey: '0x...' });
 * const result = await client.generate('A cute cat in space');
 * console.log(result.data[0].url);
 */

// Native BlockRun API
export { LLMClient, testnetClient, default } from "./client";
export { ImageClient } from "./image";
export { MusicClient } from "./music";
export {
  type ChatMessage,
  type ChatChoice,
  type ChatUsage,
  type ChatResponse,
  type Model,
  type LLMClientOptions,
  type ChatOptions,
  type ChatCompletionOptions,
  // Tool calling types
  type FunctionDefinition,
  type Tool,
  type FunctionCall,
  type ToolCall,
  type ToolChoice,
  // Image types
  type ImageData,
  type ImageResponse,
  type ImageModel,
  type ImageClientOptions,
  type ImageGenerateOptions,
  type ImageEditOptions,
  // Music / Audio types
  type AudioTrack,
  type MusicResponse,
  type AudioModel,
  type MusicClientOptions,
  type MusicGenerateOptions,
  // Video types
  type VideoClip,
  type VideoResponse,
  type VideoModel,
  type VideoClientOptions,
  type VideoGenerateOptions,
  // Live Search types
  type WebSearchSource,
  type XSearchSource,
  type NewsSearchSource,
  type RssSearchSource,
  type SearchSource,
  type SearchParameters,
  // Search result
  type SearchResult,
  type SearchOptions,
  // Spending tracking
  type Spending,
  type SearchUsage,
  type CostEstimate,
  type SpendingReport,
  type ChatResponseWithCost,
  // Smart routing types
  type RoutingProfile,
  type RoutingTier,
  type RoutingDecision,
  type SmartChatOptions,
  type SmartChatResponse,
  // X/Twitter types (powered by AttentionVC)
  type XUser,
  type XUserLookupResponse,
  type XFollower,
  type XFollowersResponse,
  type XFollowingsResponse,
  type XUserInfoResponse,
  type XVerifiedFollowersResponse,
  type XTweet,
  type XTweetsResponse,
  type XMentionsResponse,
  type XTweetLookupResponse,
  type XTweetRepliesResponse,
  type XTweetThreadResponse,
  type XSearchResponse,
  type XTrendingResponse,
  type XArticlesRisingResponse,
  type XAuthorAnalyticsResponse,
  type XCompareAuthorsResponse,
  // Error classes
  BlockrunError,
  PaymentError,
  APIError,
} from "./types";
export {
  BASE_CHAIN_ID,
  USDC_BASE,
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  type CreatePaymentOptions,
} from "./x402";

// Wallet management utilities
export {
  createWallet,
  saveWallet,
  loadWallet,
  scanWallets,
  getOrCreateWallet,
  getWalletAddress,
  getEip681Uri,
  getPaymentLinks,
  formatWalletCreatedMessage,
  formatNeedsFundingMessage,
  formatFundingMessageCompact,
  USDC_BASE_CONTRACT,
  WALLET_FILE_PATH,
  WALLET_DIR_PATH,
  type WalletInfo,
  type PaymentLinks,
} from "./wallet";

// Solana client
export { SolanaLLMClient, solanaClient, type SolanaLLMClientOptions } from "./solana-client";

// Solana wallet utilities
export {
  createSolanaWallet,
  saveSolanaWallet,
  loadSolanaWallet,
  scanSolanaWallets,
  getOrCreateSolanaWallet,
  solanaKeyToBytes,
  solanaPublicKey,
  SOLANA_WALLET_FILE_PATH,
  type SolanaWalletInfo,
} from "./solana-wallet";

// Solana x402 constants
export { SOLANA_NETWORK, USDC_SOLANA, createSolanaPaymentPayload } from "./x402";

// Cache utilities
export { getCached, setCache, clearCache, saveToCache, getCachedByRequest, getCostLogSummary } from "./cache";

// Agent wallet setup
export { setupAgentWallet, setupAgentSolanaWallet, status } from "./setup";

// Cost logging
export { logCost, getCostSummary, type CostEntry } from "./cost-log";

// OpenAI-compatible API
export { OpenAI } from "./openai-compat";
export type {
  OpenAIClientOptions,
  OpenAIChatCompletionParams,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChoice,
  OpenAIChatCompletionChunk,
} from "./openai-compat";

// Anthropic-compatible API
export { AnthropicClient } from "./anthropic-compat";
export type { BlockRunAnthropicOptions } from "./anthropic-compat";

// Validation utilities
export {
  KNOWN_PROVIDERS,
  validateModel,
  validateMaxTokens,
  validateTemperature,
  validateTopP,
} from "./validation";
