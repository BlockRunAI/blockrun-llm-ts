/**
 * BlockRun LLM SDK - Pay-per-request AI via x402 on Base
 *
 * Two ways to use:
 *
 * @example Simple API (BlockRun native)
 * import { LLMClient } from '@blockrun/llm';
 *
 * const client = new LLMClient({ privateKey: '0x...' });
 * const response = await client.chat('gpt-4o', 'Hello!');
 * console.log(response);
 *
 * @example OpenAI-compatible API (drop-in replacement)
 * import { OpenAI } from '@blockrun/llm';
 *
 * const client = new OpenAI({ walletKey: '0x...' });
 * const response = await client.chat.completions.create({
 *   model: 'gpt-4o',
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
  // xAI Live Search types
  type WebSearchSource,
  type XSearchSource,
  type NewsSearchSource,
  type RssSearchSource,
  type SearchSource,
  type SearchParameters,
  // Spending tracking
  type Spending,
  // Smart routing types
  type RoutingProfile,
  type RoutingTier,
  type RoutingDecision,
  type SmartChatOptions,
  type SmartChatResponse,
  // Error classes
  BlockrunError,
  PaymentError,
  APIError,
} from "./types";
export { BASE_CHAIN_ID, USDC_BASE } from "./x402";

// Wallet management utilities
export {
  createWallet,
  saveWallet,
  loadWallet,
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

// OpenAI-compatible API
export { OpenAI } from "./openai-compat";
export type {
  OpenAIClientOptions,
  OpenAIChatCompletionParams,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChoice,
  OpenAIChatCompletionChunk,
} from "./openai-compat";
