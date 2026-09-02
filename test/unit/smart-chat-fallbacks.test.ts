import { describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/client";
import { APIError } from "../../src/types";
import { routingText, routeWithCatalog } from "../../src/router-adapter";
import { DEFAULT_MODEL_CAPABILITIES } from "@blockrun/router-core";
import { TEST_PRIVATE_KEY, buildChatResponse } from "../helpers/testHelpers";

// The router runtime is bundled (@blockrun/router-core), so these tests run
// the REAL portfolio router against synthetic catalog pricing maps — no
// router mocks. What varies per test is the catalog.
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

function makeClient(pricing: Map<string, { inputPrice: number; outputPrice: number }> = routerPricing()) {
  const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
  vi.spyOn(client as never, "getModelPricing" as never).mockResolvedValue(pricing as never);
  return client;
}

describe("Router Core SDK integration", () => {
  it("uses the V3 portfolio decision and ordered live-catalog fallbacks", async () => {
    const client = makeClient();
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

  it("heads eco with the gateway-native free tier (eco stays $0)", async () => {
    // Guards the property behind the v3.11.0 regression: eco must not
    // silently become a paid profile. The vehicle has migrated with the free
    // tier itself — free/deepseek-v4-flash until 18bf4ab (NVIDIA 410), the
    // gpt-oss pair until 9386c53 retired it (gateway 400, probed
    // 2026-08-21), then step-3.7-flash until router-core 5ee7c23, when NVIDIA
    // 410'd four of the five visible free models at once (2026-08-30). Since
    // 9386c53 the chains carry the gateway-native nvidia/* ids directly, so
    // the adapter's free/*→nvidia/* mapping branch is dormant with the current
    // pin — it stays in the adapter because pins move independently, and the
    // "drops proxy-only free ids" test below keeps the drop path honest.
    //
    // The id is asserted deliberately. blockrun server-redirects retired free
    // ids, so a stale head keeps returning answers — from a model the router
    // did not name. Failing here on the exact id is what forces a human to
    // look when the free tier moves under the pin.
    const pricing = routerPricing();
    pricing.set("nvidia/nemotron-3.5-lightning", { inputPrice: 0, outputPrice: 0 });

    const decision = routeWithCatalog("Name the capital of France. One word.", undefined, 50, pricing, {
      routingProfile: "eco",
    });

    expect(decision.model).toBe("nvidia/nemotron-3.5-lightning");
    expect(decision.costEstimate).toBe(0); // free models settle at $0 — no payment floor
    expect(decision.savings).toBe(1);
  });

  it("keeps router-ranked ids that are absent from the catalog pricing", async () => {
    // The adapter must not filter the ranking by catalog presence: a model the
    // gateway serves by direct id but withholds from /v1/models (kimi-k2.7 was
    // the standing example until router-core V3.5 stopped naming hidden ids)
    // would otherwise be silently swapped for a model the router did not
    // choose. Simulate the withheld case by deleting a chain rung's pricing.
    const pricing = routerPricing();
    pricing.delete("google/gemini-3.6-flash");

    const decision = routeWithCatalog("Hello there!", undefined, 50, pricing, {
      routingProfile: "premium",
    });

    expect(decision.candidates).toContain("google/gemini-3.6-flash");
  });

  it("drops proxy-only free ids that have no nvidia/* mapping in the catalog", async () => {
    // free/gpt-oss-120b exists only behind ClawRouter's proxy; unmapped it
    // draws a hard 400 (non-transient), so it must never be sent.
    const decision = routeWithCatalog("Name the capital of France. One word.", undefined, 50, routerPricing(), {
      routingProfile: "eco",
    });

    expect(decision.model.startsWith("free/")).toBe(false);
    for (const id of decision.candidates ?? []) {
      expect(id.startsWith("free/")).toBe(false);
    }
  });

  it("routes full Agent messages with their required tools", async () => {
    const client = makeClient();
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

  it("honors caller-supplied fallbackModels over the routed chain", async () => {
    const client = makeClient();
    const completionSpy = vi.spyOn(client, "chatCompletion").mockResolvedValue(buildChatResponse());

    await client.smartChatCompletion(
      [{ role: "user", content: "Explain why the sky is blue." }],
      { fallbackModels: ["deepseek/deepseek-chat"] },
    );

    expect(completionSpy.mock.calls[0][2]?.fallbackModels).toEqual(["deepseek/deepseek-chat"]);
  });

  it("resolves blockrun/auto before the paid gateway request", async () => {
    const client = makeClient();
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

  it("resolves blockrun/auto for streaming requests", async () => {
    const client = makeClient();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: [DONE]\n\n", { status: 200 }),
    );

    try {
      await client.chatCompletionStream("blockrun/auto", [{ role: "user", content: "hi" }]);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
        model: string;
      };
      expect(body.model).not.toBe("blockrun/auto");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("floors paid route cost metadata at the Base minimum", async () => {
    const client = makeClient();
    const decision = await client.route("Hello", { maxOutputTokens: 8 });
    expect(decision.costEstimate).toBe(0.002);
  });

  it("keeps ranked non-free ids even when the catalog omits them, but never free/*", async () => {
    // Trust policy: withheld-but-callable ids stay routable (the router
    // priced them from its own snapshot); only the free/* proxy namespace
    // requires a catalog mapping to be callable.
    const client = makeClient(
      new Map([["deepseek/deepseek-chat", { inputPrice: 0.2, outputPrice: 0.4 }]]),
    );

    const decision = await client.route("Debug and fix the failing tests.");

    expect(decision.candidates).toContain("deepseek/deepseek-chat");
    for (const id of decision.candidates ?? []) {
      expect(id.startsWith("free/")).toBe(false);
    }
  });

  it("filters candidates that cannot fit the conversation in their context window", async () => {
    // A ~600k-token conversation must knock out small-context models even
    // though the routing prompt (the last user message) is tiny.
    const conversationChars = 2_400_000;
    const neededContext = (Math.ceil(conversationChars / 4) + 1024) * 1.1;

    const decision = routeWithCatalog("Summarize our discussion.", undefined, 1024, routerPricing(), {
      conversationChars,
    });

    expect(decision.candidates?.length).toBeGreaterThan(0);
    for (const id of decision.candidates ?? []) {
      const caps = DEFAULT_MODEL_CAPABILITIES[id];
      if (caps) expect(caps.contextWindow).toBeGreaterThanOrEqual(neededContext);
    }
  });
});

describe("routingText", () => {
  it("routes on the last user message plus joined system text", () => {
    const { prompt, systemPrompt } = routingText([
      { role: "system", content: "Be terse." },
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second question" },
    ]);
    expect(prompt).toBe("second question");
    expect(systemPrompt).toBe("Be terse.");
  });

  it("handles empty message arrays without throwing", () => {
    const { prompt, systemPrompt } = routingText([]);
    expect(prompt).toBe("");
    expect(systemPrompt).toBeUndefined();
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
