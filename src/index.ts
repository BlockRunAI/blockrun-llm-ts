/**
 * BlockRun LLM SDK - Pay-per-request AI via x402 on Base
 *
 * @example
 * import { LLMClient } from '@blockrun/llm';
 *
 * const client = new LLMClient({ privateKey: '0x...' });
 * const response = await client.chat('gpt-4o', 'Hello!');
 * console.log(response);
 */

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
