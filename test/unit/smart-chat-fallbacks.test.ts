import { describe, it, expect, vi, beforeEach } from "vitest";
import { LLMClient } from "../../src/client";
import type { Model, RoutingTier, RoutingTierConfig } from "../../src/types";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

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
        "unpriced/model", // not in the catalog — must be filtered out
        "openai/gpt-4o",
      ],
    });

    const { client, chatSpy } = makeClient();
    const result = await client.smartChat("What is 2+2?");

    expect(result.routing.fallbacks).toEqual([
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4o",
    ]);
    expect(chatSpy).toHaveBeenCalledWith(
      "google/gemini-2.5-flash",
      "What is 2+2?",
      expect.objectContaining({
        fallbackModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-4o"],
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
