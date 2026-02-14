/**
 * OpenAI-compatible API wrapper for BlockRun LLM SDK.
 *
 * Drop-in replacement for OpenAI SDK - just change the import and use walletKey instead of apiKey.
 *
 * @example
 * // Before (OpenAI)
 * import OpenAI from 'openai';
 * const client = new OpenAI({ apiKey: 'sk-...' });
 *
 * // After (BlockRun)
 * import { OpenAI } from '@blockrun/llm';
 * const client = new OpenAI({ walletKey: '0x...' });
 *
 * // Rest of your code stays exactly the same!
 * const response = await client.chat.completions.create({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello!' }]
 * });
 */

import { LLMClient } from "./client";
import type { ChatMessage, ChatResponse, Tool, ToolCall, ToolChoice } from "./types";

// OpenAI-compatible types
export interface OpenAIClientOptions {
  /** EVM wallet private key (replaces apiKey) */
  walletKey?: `0x${string}` | string;
  /** Alternative: use privateKey like LLMClient */
  privateKey?: `0x${string}` | string;
  /** API endpoint URL (default: https://blockrun.ai/api) */
  baseURL?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
}

export interface OpenAIChatCompletionParams {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
  }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  n?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: Tool[];
  tool_choice?: ToolChoice;
}

export interface OpenAIChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Streaming types
export interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

/**
 * Async iterator for streaming responses
 */
class StreamingResponse implements AsyncIterable<OpenAIChatCompletionChunk> {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder: InstanceType<typeof TextDecoder>;
  private buffer: string = "";
  private model: string;
  private id: string;

  constructor(response: Response, model: string) {
    if (!response.body) {
      throw new Error("Response body is null");
    }
    this.reader = response.body.getReader();
    this.decoder = new TextDecoder();
    this.model = model;
    this.id = `chatcmpl-${Date.now()}`;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<OpenAIChatCompletionChunk> {
    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;

        this.buffer += this.decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            yield this.transformChunk(parsed);
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      this.reader.releaseLock();
    }
  }

  private transformChunk(data: Record<string, unknown>): OpenAIChatCompletionChunk {
    // Handle both OpenAI format and custom formats
    const choices = (data.choices as Array<Record<string, unknown>>) || [];

    return {
      id: (data.id as string) || this.id,
      object: "chat.completion.chunk",
      created: (data.created as number) || Math.floor(Date.now() / 1000),
      model: (data.model as string) || this.model,
      choices: choices.map((choice, index) => ({
        index: (choice.index as number) ?? index,
        delta: {
          role: (choice.delta as Record<string, unknown>)?.role as "assistant" | undefined,
          content: (choice.delta as Record<string, unknown>)?.content as string | undefined,
        },
        finish_reason: (choice.finish_reason as string) || null,
      })),
    };
  }
}

/**
 * Chat completions API (OpenAI-compatible)
 */
class ChatCompletions {
  constructor(private client: LLMClient, private apiUrl: string, private timeout: number) {}

  /**
   * Create a chat completion (OpenAI-compatible).
   */
  async create(params: OpenAIChatCompletionParams): Promise<OpenAIChatCompletionResponse>;
  async create(params: OpenAIChatCompletionParams & { stream: true }): Promise<AsyncIterable<OpenAIChatCompletionChunk>>;
  async create(params: OpenAIChatCompletionParams): Promise<OpenAIChatCompletionResponse | AsyncIterable<OpenAIChatCompletionChunk>> {
    if (params.stream) {
      return this.createStream(params);
    }

    const response = await this.client.chatCompletion(
      params.model,
      params.messages as ChatMessage[],
      {
        maxTokens: params.max_tokens,
        temperature: params.temperature,
        topP: params.top_p,
        tools: params.tools,
        toolChoice: params.tool_choice,
      }
    );

    return this.transformResponse(response);
  }

  private async createStream(params: OpenAIChatCompletionParams): Promise<AsyncIterable<OpenAIChatCompletionChunk>> {
    const url = `${this.apiUrl}/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.max_tokens || 1024,
      temperature: params.temperature,
      top_p: params.top_p,
      stream: true,
    };
    if (params.tools) {
      body.tools = params.tools;
    }
    if (params.tool_choice) {
      body.tool_choice = params.tool_choice;
    }

    // First request to get 402
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Handle 402
      if (response.status === 402) {
        const paymentHeader = response.headers.get("payment-required");
        if (!paymentHeader) {
          throw new Error("402 response but no payment requirements found");
        }

        // Streaming with automatic payment is not currently supported
        // The SDK would need direct access to the private key to sign payments
        // For now, throw an error asking user to use non-streaming
        throw new Error(
          "Streaming with automatic payment requires direct wallet access. " +
          "Please use non-streaming mode or contact support for streaming setup."
        );
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      return new StreamingResponse(response, params.model);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private transformResponse(response: ChatResponse): OpenAIChatCompletionResponse {
    return {
      id: response.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: response.created || Math.floor(Date.now() / 1000),
      model: response.model,
      choices: response.choices.map((choice, index) => ({
        index: choice.index ?? index,
        message: {
          role: "assistant" as const,
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        },
        finish_reason: choice.finish_reason || "stop",
      })),
      usage: response.usage,
    };
  }
}

/**
 * Chat API namespace
 */
class Chat {
  public completions: ChatCompletions;

  constructor(client: LLMClient, apiUrl: string, timeout: number) {
    this.completions = new ChatCompletions(client, apiUrl, timeout);
  }
}

/**
 * OpenAI-compatible client for BlockRun.
 *
 * Drop-in replacement for the OpenAI SDK.
 *
 * @example
 * import { OpenAI } from '@blockrun/llm';
 *
 * const client = new OpenAI({ walletKey: '0x...' });
 *
 * const response = await client.chat.completions.create({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello!' }]
 * });
 *
 * console.log(response.choices[0].message.content);
 */
export class OpenAI {
  public chat: Chat;
  private client: LLMClient;

  constructor(options: OpenAIClientOptions = {}) {
    const privateKey = options.walletKey || options.privateKey;
    const apiUrl = options.baseURL || "https://blockrun.ai/api";
    const timeout = options.timeout || 60000;

    this.client = new LLMClient({
      privateKey: privateKey as `0x${string}`,
      apiUrl,
      timeout,
    });

    this.chat = new Chat(this.client, apiUrl, timeout);
  }

  /**
   * Get the wallet address being used for payments.
   */
  getWalletAddress(): string {
    return this.client.getWalletAddress();
  }
}

export default OpenAI;
