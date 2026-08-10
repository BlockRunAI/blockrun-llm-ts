import { describe, it, expect, vi, beforeEach } from "vitest";
import { LLMClient } from "../../src/client";
import { APIError } from "../../src/types";
import type { Model, RoutingTier, RoutingTierConfig } from "../../src/types";
import { TEST_PRIVATE_KEY, buildChatResponse } from "../helpers/testHelpers";

// smartChat() loads '@blockrun/clawrouter' with a dynamic import; vitest
// intercepts that the same as a static one.
const routeMock = vi.fn();
const getFallbackChainMock = vi.fn();

const TIERS: Record<RoutingTier, RoutingTierConfig> = {
  SIMPLE: { primary: "google/gemini-2.5-flash", fallback: ["openai/gpt-4o"] },
  MEDIUM: { primary: "openai/gpt-4o", fallback: ["anthropic/claude-sonnet-4.5"] },
  COMPLEX: { primary: "anthropic/claude-sonnet-4.5", fallback: ["openai/gpt-4o"] },
  REASONING: { primary: "anthropic/claude-sonnet-4.5", fallback: ["openai/gpt-4o"] },
};

vi.mock("@blockrun/clawrouter", () => ({
  route: (...args: unknown[]) => routeMock(...args),
  DEFAULT_ROUTING_CONFIG: {
    tiers: {
      SIMPLE: { primary: "google/gemini-2.5-flash", fallback: ["openai/gpt-4o"] },
      MEDIUM: { primary: "openai/gpt-4o", fallback: ["anthropic/claude-sonnet-4.5"] },
      COMPLEX: { primary: "anthropic/claude-sonnet-4.5", fallback: ["openai/gpt-4o"] },
      REASONING: { primary: "anthropic/claude-sonnet-4.5", fallback: ["openai/gpt-4o"] },
    },
  },
  getFallbackChain: (...args: unknown[]) => getFallbackChainMock(...args),
}));

const PRICED_MODELS = [
  { id: "google/gemini-2.5-flash", inputPrice: 0.15, outputPrice: 0.6 },
  { id: "openai/gpt-4o", inputPrice: 2.5, outputPrice: 10.0 },
  { id: "anthropic/claude-sonnet-4.5", inputPrice: 3.0, outputPrice: 15.0 },
] as Model[];

function baseDecision() {
  return {
    model: "google/gemini-2.5-flash",
    tier: "SIMPLE" as const,
    confidence: 0.9,
    reasoning: "test",
    costEstimate: 0.001,
    baselineCost: 0.01,
    savings: 0.9,
    tierConfigs: TIERS,
  };
}

function makeClient() {
  const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
  vi.spyOn(client, "listModels").mockResolvedValue(PRICED_MODELS);
  const chatSpy = vi.spyOn(client, "chat").mockResolvedValue("ok");
  return { client, chatSpy };
}

describe("smartChat fallback chain", () => {
  beforeEach(() => {
    routeMock.mockReset();
    getFallbackChainMock.mockReset();
  });

  it("prefers the portfolio router's ranked candidates over the tier chain", async () => {
    routeMock.mockReturnValue({
      ...baseDecision(),
      method: "portfolio",
      routerVersion: "v3-portfolio",
      candidates: [
        "google/gemini-2.5-flash", // primary — must be excluded from fallbacks
        "anthropic/claude-sonnet-4.5",
        "moonshot/kimi-k2.7", // withheld from /v1/models — kept: the gateway serves it by direct id
        "openai/gpt-4o",
      ],
    });

    const { client, chatSpy } = makeClient();
    const result = await client.smartChat("What is 2+2?");

    expect(result.routing.fallbacks).toEqual([
      "anthropic/claude-sonnet-4.5",
      "moonshot/kimi-k2.7",
      "openai/gpt-4o",
    ]);
    expect(chatSpy).toHaveBeenCalledWith(
      "google/gemini-2.5-flash",
      "What is 2+2?",
      expect.objectContaining({
        fallbackModels: [
          "anthropic/claude-sonnet-4.5",
          "moonshot/kimi-k2.7",
          "openai/gpt-4o",
        ],
      }),
    );
    // The candidate ordering is authoritative; the tier chain is not consulted.
    expect(getFallbackChainMock).not.toHaveBeenCalled();
  });

  it("falls back to the tier chain for rules-mode decisions without candidates", async () => {
    routeMock.mockReturnValue({ ...baseDecision(), method: "rules" });
    getFallbackChainMock.mockReturnValue([
      "google/gemini-2.5-flash",
      "openai/gpt-4o",
    ]);

    const { client } = makeClient();
    const result = await client.smartChat("What is 2+2?");

    expect(getFallbackChainMock).toHaveBeenCalledWith("SIMPLE", TIERS);
    expect(result.routing.fallbacks).toEqual(["openai/gpt-4o"]);
  });

  it("treats an empty candidates array like a missing one", async () => {
    routeMock.mockReturnValue({
      ...baseDecision(),
      method: "portfolio",
      candidates: [],
    });
    getFallbackChainMock.mockReturnValue(["openai/gpt-4o"]);

    const { client } = makeClient();
    const result = await client.smartChat("What is 2+2?");

    expect(getFallbackChainMock).toHaveBeenCalled();
    expect(result.routing.fallbacks).toEqual(["openai/gpt-4o"]);
  });

  it("maps ClawRouter's free/* ids to the gateway's nvidia/* ids", async () => {
    routeMock.mockReturnValue({
      ...baseDecision(),
      model: "free/deepseek-v4-flash",
      method: "portfolio",
      candidates: ["free/deepseek-v4-flash", "openai/gpt-4o"],
    });

    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    vi.spyOn(client, "listModels").mockResolvedValue([
      ...PRICED_MODELS,
      { id: "nvidia/deepseek-v4-flash", inputPrice: 0, outputPrice: 0 },
    ] as Model[]);
    const chatSpy = vi.spyOn(client, "chat").mockResolvedValue("ok");

    const result = await client.smartChat("hello");

    // The proxy-namespace id resolves to the callable gateway id.
    expect(chatSpy).toHaveBeenCalledWith(
      "nvidia/deepseek-v4-flash",
      "hello",
      expect.objectContaining({ fallbackModels: ["openai/gpt-4o"] }),
    );
    expect(result.model).toBe("nvidia/deepseek-v4-flash");
    expect(result.routing.model).toBe("nvidia/deepseek-v4-flash");
  });

  it("skips an un-callable primary in favor of the first callable candidate", async () => {
    // free/gpt-oss-120b has no nvidia/* mapping in the catalog (withheld
    // from /v1/models) — calling it draws a hard 400 from the gateway, so
    // the SDK must not send it.
    routeMock.mockReturnValue({
      ...baseDecision(),
      model: "free/gpt-oss-120b",
      method: "portfolio",
      candidates: [
        "free/gpt-oss-120b",
        "google/gemini-2.5-flash",
        "openai/gpt-4o",
      ],
    });

    const { client, chatSpy } = makeClient();
    const result = await client.smartChat("hello");

    expect(chatSpy).toHaveBeenCalledWith(
      "google/gemini-2.5-flash",
      "hello",
      expect.objectContaining({ fallbackModels: ["openai/gpt-4o"] }),
    );
    expect(result.model).toBe("google/gemini-2.5-flash");
  });

  it("surfaces the portfolio metadata on the routing result", async () => {
    routeMock.mockReturnValue({
      ...baseDecision(),
      method: "portfolio",
      routerVersion: "v3-portfolio",
      taskType: "chat",
      candidates: ["google/gemini-2.5-flash", "openai/gpt-4o"],
    });

    const { client } = makeClient();
    const result = await client.smartChat("hello");

    expect(result.routing.method).toBe("portfolio");
    expect(result.routing.routerVersion).toBe("v3-portfolio");
    expect(result.routing.taskType).toBe("chat");
    expect(result.routing.candidates).toEqual([
      "google/gemini-2.5-flash",
      "openai/gpt-4o",
    ]);
  });
});

describe("chatCompletion fallback walk", () => {
  it("falls over to the next model on 429 (saturated upstream)", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const reqSpy = vi
      .spyOn(
        client as unknown as { requestWithPayment: (...a: unknown[]) => unknown },
        "requestWithPayment",
      )
      .mockRejectedValueOnce(new APIError("rate limited", 429))
      .mockResolvedValueOnce(buildChatResponse({ content: "recovered" }));

    const result = await client.chatCompletion(
      "nvidia/gpt-oss-120b",
      [{ role: "user", content: "hi" }],
      { fallbackModels: ["google/gemini-2.5-flash"] },
    );

    expect(result.choices[0].message.content).toBe("recovered");
    expect(reqSpy).toHaveBeenCalledTimes(2);
    const secondBody = reqSpy.mock.calls[1][1] as { model: string };
    expect(secondBody.model).toBe("google/gemini-2.5-flash");
  });

  it("does not walk the chain on non-transient 4xx", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const reqSpy = vi
      .spyOn(
        client as unknown as { requestWithPayment: (...a: unknown[]) => unknown },
        "requestWithPayment",
      )
      .mockRejectedValueOnce(new APIError("bad request", 400));

    await expect(
      client.chatCompletion("openai/gpt-4o", [{ role: "user", content: "hi" }], {
        fallbackModels: ["google/gemini-2.5-flash"],
      }),
    ).rejects.toThrow("bad request");
    expect(reqSpy).toHaveBeenCalledTimes(1);
  });
});
