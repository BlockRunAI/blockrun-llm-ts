import { describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/client";
import { TEST_PRIVATE_KEY, buildChatResponse } from "../helpers/testHelpers";

function routerPricing() {
  return new Map([
    ["openai/gpt-5.3-codex", { inputPrice: 1.75, outputPrice: 14 }],
    ["anthropic/claude-sonnet-5", { inputPrice: 3, outputPrice: 15 }],
    ["openai/gpt-5-mini", { inputPrice: 0.25, outputPrice: 2 }],
    ["google/gemini-3.5-flash", { inputPrice: 0.5, outputPrice: 3 }],
    ["moonshot/kimi-k3", { inputPrice: 3, outputPrice: 15 }],
    ["moonshot/kimi-k2.7", { inputPrice: 0.5, outputPrice: 2 }],
    ["deepseek/deepseek-v4-pro", { inputPrice: 0.435, outputPrice: 0.87 }],
    ["deepseek/deepseek-chat", { inputPrice: 0.2, outputPrice: 0.4 }],
    ["google/gemini-2.5-flash", { inputPrice: 0.3, outputPrice: 2.5 }],
    ["anthropic/claude-opus-4.8", { inputPrice: 5, outputPrice: 25 }],
  ]);
}

describe("Router Core SDK integration", () => {
  it("uses the V3 portfolio decision and ordered live-catalog fallbacks", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    vi.spyOn(client as never, "getModelPricing" as never).mockResolvedValue(routerPricing() as never);
    const chatSpy = vi.spyOn(client, "chat").mockResolvedValue("fixed");

    const result = await client.smartChat(
      "Inspect the TypeScript repository, debug the failing tests, edit the files, and verify the fix.",
    );

    expect(result.response).toBe("fixed");
    expect(result.routing.routerVersion).toBe("v3-portfolio");
    expect(result.routing.method).toBe("portfolio");
    expect(result.routing.candidates?.[0]).toBe(result.model);
    expect(chatSpy.mock.calls[0][0]).toBe(result.model);
    expect(chatSpy.mock.calls[0][2]?.fallbackModels).toEqual(result.routing.fallbacks);
  });

  it("never calls a candidate missing from the current catalog", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    vi.spyOn(client as never, "getModelPricing" as never).mockResolvedValue(
      new Map([["deepseek/deepseek-chat", { inputPrice: 0.2, outputPrice: 0.4 }]]) as never,
    );

    const decision = await client.route("Debug and fix the failing tests.");

    expect(decision.model).toBe("deepseek/deepseek-chat");
    expect(decision.candidates).toEqual(["deepseek/deepseek-chat"]);
  });

  it("routes full Agent messages with their required tools", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    vi.spyOn(client as never, "getModelPricing" as never).mockResolvedValue(routerPricing() as never);
    const completionSpy = vi.spyOn(client, "chatCompletion").mockResolvedValue(buildChatResponse());
    const tools = [{
      type: "function" as const,
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: {} },
      },
    }];

    const result = await client.smartChatCompletion(
      [{ role: "user", content: "Get the weather in Tokyo and report it." }],
      { tools, toolChoice: "required" },
    );

    expect(result.routing.taskType).toBe("tool_agent");
    expect(result.response.routing).toEqual(result.routing);
    expect(completionSpy.mock.calls[0][2]?.tools).toEqual(tools);
  });

  it("resolves blockrun/auto before the paid gateway request", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    vi.spyOn(client as never, "getModelPricing" as never).mockResolvedValue(routerPricing() as never);
    const requestSpy = vi
      .spyOn(client as never, "requestWithPayment" as never)
      .mockResolvedValue(buildChatResponse() as never);

    const response = await client.chatCompletion(
      "blockrun/auto",
      [{ role: "user", content: "Explain why the sky is blue." }],
    );

    const body = requestSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(response.routing?.routerVersion).toBe("v3-portfolio");
    expect(body.model).toBe(response.routing?.model);
    expect(body.model).not.toBe("blockrun/auto");
  });

  it("uses the live Base minimum in route cost metadata", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    vi.spyOn(client as never, "getModelPricing" as never).mockResolvedValue(routerPricing() as never);

    const decision = await client.route("Hello", { maxOutputTokens: 8 });

    expect(decision.costEstimate).toBe(0.002);
  });
});
