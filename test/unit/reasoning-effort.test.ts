import { describe, it, expect, vi, afterEach } from "vitest";
import { LLMClient } from "../../src/client";
import { SolanaLLMClient } from "../../src/solana-client";
import { OpenAI } from "../../src/openai-compat";
import { TEST_PRIVATE_KEY, buildChatResponse } from "../helpers/testHelpers";

// `reasoningEffort` must reach the gateway as `reasoning_effort` on every chat
// entry point, and must be ABSENT when the caller does not set it — some
// models default to their highest effort (Reflection Beam: "max"), so a
// silently dropped option is a slower, dearer call, and a silently invented
// one would override the model's own default.

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";
const MESSAGES = [{ role: "user" as const, content: "hi" }];
const BEAM = "reflection/beam-1.0-501b-a23b";

afterEach(() => vi.restoreAllMocks());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spyBody(client: any) {
  const spy = vi.spyOn(client, "requestWithPayment").mockResolvedValue(buildChatResponse());
  return () => spy.mock.calls[spy.mock.calls.length - 1][1] as Record<string, unknown>;
}

describe("SolanaLLMClient reasoningEffort", () => {
  it("chatCompletion sends reasoning_effort", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    const body = spyBody(client);
    await client.chatCompletion(BEAM, MESSAGES, { reasoningEffort: "low" });
    expect(body().reasoning_effort).toBe("low");
  });

  it("chat() relays it", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    const body = spyBody(client);
    await client.chat(BEAM, "hi", { reasoningEffort: "medium" });
    expect(body().reasoning_effort).toBe("medium");
  });

  it("is absent when unset", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    const body = spyBody(client);
    await client.chatCompletion(BEAM, MESSAGES);
    expect("reasoning_effort" in body()).toBe(false);
  });

  it("rides every model of a fallback chain", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    const { APIError, withDisposition } = await import("../../src/types");
    const spy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(client as any, "requestWithPayment")
      .mockRejectedValueOnce(withDisposition(new APIError("upstream unavailable", 503), "unpaid"))
      .mockResolvedValueOnce(buildChatResponse());
    await client.chatCompletion(BEAM, MESSAGES, { reasoningEffort: "high", fallbackModels: ["minimax/minimax-m3"] });
    const bodies = spy.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(bodies.map((b: Record<string, unknown>) => b.reasoning_effort)).toEqual(["high", "high"]);
  });
});

describe("LLMClient reasoningEffort", () => {
  it("chatCompletion sends reasoning_effort", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const body = spyBody(client);
    await client.chatCompletion("openai/gpt-5.6", MESSAGES, { reasoningEffort: "xhigh" });
    expect(body().reasoning_effort).toBe("xhigh");
  });

  it("chat() relays it, and it is absent when unset", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const body = spyBody(client);
    await client.chat("openai/gpt-5.6", "hi", { reasoningEffort: "max" });
    expect(body().reasoning_effort).toBe("max");
    await client.chat("openai/gpt-5.6", "hi");
    expect("reasoning_effort" in body()).toBe(false);
  });

  it("chatCompletionStream sends reasoning_effort in the streamed request body", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const sse =
      'data: {"id":"s","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const fetchSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(client as any, "fetchWithTimeout")
      .mockResolvedValue(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    await client.chatCompletionStream("openai/gpt-5.6", MESSAGES, { reasoningEffort: "low" });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).reasoning_effort).toBe("low");
  });
});

describe("OpenAI-compatible wrapper", () => {
  it("maps reasoning_effort through to the gateway body", async () => {
    const openai = new OpenAI({ walletKey: TEST_PRIVATE_KEY });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = (openai as any).client as LLMClient;
    const body = spyBody(inner);
    await openai.chat.completions.create({ model: "openai/gpt-5.6", messages: MESSAGES, reasoning_effort: "medium" });
    expect(body().reasoning_effort).toBe("medium");
  });
});
