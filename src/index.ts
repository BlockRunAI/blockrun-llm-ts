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
 */

// Native BlockRun API
export { LLMClient, default } from "./client";
export {
  type ChatMessage,
  type ChatChoice,
  type ChatUsage,
  type ChatResponse,
  type Model,
  type LLMClientOptions,
  type ChatOptions,
  type ChatCompletionOptions,
  BlockrunError,
  PaymentError,
  APIError,
} from "./types";
export { BASE_CHAIN_ID, USDC_BASE } from "./x402";

// OpenAI-compatible API
export { OpenAI } from "./openai-compat";
export type {
  OpenAIClientOptions,
  OpenAIChatCompletionParams,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChoice,
  OpenAIChatCompletionChunk,
} from "./openai-compat";
