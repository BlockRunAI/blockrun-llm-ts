import { describe, it, expectTypeOf } from "vitest";
import { OpenAI } from "../../src/index";
import type { OpenAIChatCompletionChunk, OpenAIChatCompletionResponse } from "../../src/index";

describe("OpenAI.chat.completions.create overloads", () => {
  const client = new OpenAI({ privateKey: "0x" + "11".repeat(32) });
  const messages = [{ role: "user" as const, content: "hi" }];

  it("stream: true resolves to an async iterable of chunks", () => {
    expectTypeOf(client.chat.completions.create({ model: "openai/gpt-5-mini", messages, stream: true }))
      .resolves.toEqualTypeOf<AsyncIterable<OpenAIChatCompletionChunk>>();
  });

  it("without stream it resolves to a completion response", () => {
    expectTypeOf(client.chat.completions.create({ model: "openai/gpt-5-mini", messages }))
      .resolves.toEqualTypeOf<OpenAIChatCompletionResponse>();
  });
});
