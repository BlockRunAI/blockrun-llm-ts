import { describe, it, expect, vi, afterEach } from "vitest";
import { LLMClient } from "../../src/client";
import { SolanaLLMClient } from "../../src/solana-client";
import { toWireSearchParameters, toWireTools } from "../../src/search-wire";
import { readSettlement } from "../../src/receipt";
import { requestsSearch, routeWithCatalog } from "../../src/router-adapter";
import { TEST_PRIVATE_KEY, buildChatResponse } from "../helpers/testHelpers";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const jsonResponse = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("search wire format (the gateway reads snake_case)", () => {
  it("converts camelCase search parameters, every field", () => {
    expect(
      toWireSearchParameters({
        mode: "on",
        sources: [
          { type: "x", includedXHandles: ["@OpenAI", "xai"], enableImageUnderstanding: true },
          { type: "web", allowedWebsites: ["x.ai"], safeSearch: true },
        ],
        returnCitations: true,
        fromDate: "2026-10-01",
        toDate: "2026-10-04",
        maxSearchResults: 20,
        maxTurns: 2,
      }),
    ).toEqual({
      mode: "on",
      sources: [
        { type: "x", included_x_handles: ["OpenAI", "xai"], enable_image_understanding: true },
        { type: "web", allowed_websites: ["x.ai"], safe_search: true },
      ],
      return_citations: true,
      from_date: "2026-10-01",
      to_date: "2026-10-04",
      max_search_results: 20,
      max_turns: 2,
    });
  });

  it("keeps snake_case a caller already sent (raw dict cast to the type)", () => {
    const raw = { mode: "on", sources: [{ type: "x", included_x_handles: ["a"] }], from_date: "2026-10-01" } as never;
    expect(toWireSearchParameters(raw)).toEqual({ mode: "on", sources: [{ type: "x", included_x_handles: ["a"] }], from_date: "2026-10-01" });
  });

  it("maps x_search / web_search tools and leaves function tools alone", () => {
    const fn = { type: "function" as const, function: { name: "save" } };
    expect(
      toWireTools([
        fn,
        { type: "x_search", allowedXHandles: ["@openai"], fromDate: "2026-10-03", enableVideoUnderstanding: true },
        { type: "web_search", excludedDomains: ["spam.com"] },
      ]),
    ).toEqual([
      fn,
      { type: "x_search", allowed_x_handles: ["openai"], from_date: "2026-10-03", enable_video_understanding: true },
      { type: "web_search", excluded_domains: ["spam.com"] },
    ]);
  });

  it("SolanaLLMClient sends the wire format, not the camelCase object", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    const spy = vi.spyOn(client as any, "requestWithPayment").mockResolvedValue(buildChatResponse());
    await client.chatCompletion("xai/grok-4.3", [{ role: "user", content: "new models?" }], {
      searchParameters: { mode: "on", sources: [{ type: "x", includedXHandles: ["openai"] }], fromDate: "2026-10-04" },
      tools: [{ type: "x_search", allowedXHandles: ["xai"] }],
      timeout: 180_000,
    });
    const [, body, timeout] = spy.mock.calls[0] as [string, Record<string, unknown>, number];
    expect(body.search_parameters).toEqual({ mode: "on", sources: [{ type: "x", included_x_handles: ["openai"] }], from_date: "2026-10-04" });
    expect(body.tools).toEqual([{ type: "x_search", allowed_x_handles: ["xai"] }]);
    expect(timeout).toBe(180_000);
  });
});

function receipt(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

describe("per-call cost and settlement receipt", () => {
  it("exact: the signed quote, with the transaction from PAYMENT-RESPONSE", () => {
    const res = new Response("{}", { headers: { "PAYMENT-RESPONSE": receipt({ success: true, transaction: "5sig", network: "solana" }) } });
    expect(readSettlement(res, 0.0123, "exact")).toEqual({
      costUsd: 0.0123,
      settlement: { scheme: "exact", quotedUsd: 0.0123, transaction: "5sig", network: "solana" },
    });
  });

  it("metered: extra.chargedAmount wins over the quote", () => {
    const res = new Response("{}", { headers: { "PAYMENT-RESPONSE": receipt({ success: true, amount: "", extra: { chargedAmount: "4200" } }) } });
    expect(readSettlement(res, 0.05, "batch").costUsd).toBeCloseTo(0.0042);
  });

  it("a missing or garbled receipt never fails the call", () => {
    expect(readSettlement(new Response("{}"), 0.01, "exact").costUsd).toBe(0.01);
    expect(readSettlement(new Response("{}", { headers: { "PAYMENT-RESPONSE": "not-base64-json" } }), 0.01, "exact").costUsd).toBe(0.01);
  });

  it("a free call (no 402) reports cost 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(buildChatResponse()), { status: 200, headers: { "content-type": "application/json" } })));
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    const res = await client.chatCompletion("nvidia/nemotron-3.5-lightning", [{ role: "user", content: "hi" }]);
    expect(res.costUsd).toBe(0);
    expect(res.settlement).toEqual({ scheme: "free", quotedUsd: 0 });
  });

  it("an exact-paid call carries its cost and transaction on the response", async () => {
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push(headers);
      if (!headers["PAYMENT-SIGNATURE"]) return new Response("{}", { status: 402 });
      return new Response(JSON.stringify(buildChatResponse()), {
        status: 200,
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": receipt({ success: true, transaction: "5abc" }) },
      });
    }));
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    vi.spyOn(client as any, "readPaymentRequired").mockResolvedValue({ x402Version: 2, accepts: [] });
    vi.spyOn(client as any, "signExactPayment").mockResolvedValue({ paymentPayload: "signed", costUsd: 0.0087 });
    const res = await client.chatCompletion("anthropic/claude-sonnet-5", [{ role: "user", content: "hi" }]);
    expect(calls).toHaveLength(2);
    expect(res.costUsd).toBe(0.0087);
    expect(res.settlement).toMatchObject({ scheme: "exact", transaction: "5abc" });
    expect(client.getSpending()).toEqual({ totalUsd: 0.0087, calls: 1 });
  });
});

describe("news sources carry only the gateway's news fields", () => {
  it("never sends enable_image_understanding for a news source", () => {
    const sp = { mode: "on", sources: [{ type: "news", country: "US", enableImageUnderstanding: true }] } as never;
    expect(toWireSearchParameters(sp)).toEqual({ mode: "on", sources: [{ type: "news", country: "US" }] });
  });
});

describe("X-Payment-Receipt is a bare transaction hash", () => {
  it("is used as the transaction when it is the only receipt header", () => {
    const res = new Response("{}", { headers: { "X-Payment-Receipt": "0xabc123" } });
    expect(readSettlement(res, 0.01, "exact")).toEqual({
      costUsd: 0.01,
      settlement: { scheme: "exact", quotedUsd: 0.01, transaction: "0xabc123" },
    });
  });

  it("PAYMENT-RESPONSE's transaction wins when both are present", () => {
    const res = new Response("{}", {
      headers: { "PAYMENT-RESPONSE": receipt({ success: true, transaction: "0xfromreceipt" }), "X-Payment-Receipt": "0xother" },
    });
    expect(readSettlement(res, 0.01, "exact").settlement.transaction).toBe("0xfromreceipt");
  });
});

describe("Solana batch-paid calls report the booked charge", () => {
  it("costUsd is the batch's chargedUsd (extra.chargedAmount), equal to what getSpending() booked", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    vi.spyOn(client as any, "readPaymentRequired").mockResolvedValue({ x402Version: 2, accepts: [] });
    const paidResponse = jsonResponse(buildChatResponse(), {
      "PAYMENT-RESPONSE": receipt({ success: true, amount: "", transaction: "5batch", extra: { chargedAmount: "4200" } }),
    });
    (client as any).batchPayer = {
      closeFence: async () => 0,
      pay: async () => ({ kind: "paid", response: paidResponse, chargedUsd: 0.0042 }),
    };
    const res = await client.chatCompletion("anthropic/claude-sonnet-5", [{ role: "user", content: "hi" }]);
    expect(res.costUsd).toBe(0.0042);
    expect(res.settlement).toMatchObject({ scheme: "batch", quotedUsd: 0.0042, transaction: "5batch" });
    expect(client.getSpending()).toEqual({ totalUsd: 0.0042, calls: 1 });
  });
});

describe("LLMClient (EVM) cost and per-call timeout", () => {
  it("a free wallet call (no 402) reports cost 0, like Solana", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(buildChatResponse())));
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const res = await client.chatCompletion("nvidia/nemotron-3.5-lightning", [{ role: "user", content: "hi" }]);
    expect(res.costUsd).toBe(0);
    expect(res.settlement).toEqual({ scheme: "free", quotedUsd: 0 });
  });

  it("account (API-key) mode leaves costUsd undefined: billed to the account", async () => {
    vi.stubEnv("BLOCKRUN_API_BASE_URL", "https://api.blockrun.ai");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(buildChatResponse())));
    for (const Client of [LLMClient, SolanaLLMClient]) {
      const client = new Client({ apiKey: "brk_live_test_account" });
      const res = await client.chatCompletion("openai/gpt-5-mini", [{ role: "user", content: "hi" }]);
      expect(res.costUsd).toBeUndefined();
      expect(res.settlement).toBeUndefined();
    }
  });

  it("threads options.timeout to the unpaid and the paid request", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    vi.spyOn(client as any, "recordCost").mockImplementation(() => undefined);
    vi.spyOn(client as any, "signFrom402").mockResolvedValue({
      paymentPayload: "signed",
      details: { amount: "8700", network: "eip155:8453" },
    });
    const fetchSpy = vi
      .spyOn(client as any, "fetchWithTimeout")
      .mockResolvedValueOnce(new Response("{}", { status: 402 }))
      .mockResolvedValueOnce(
        jsonResponse(buildChatResponse(), { "PAYMENT-RESPONSE": receipt({ success: true, transaction: "0xpaid", network: "eip155:8453" }) }),
      );
    const res = await client.chatCompletion("xai/grok-4.3", [{ role: "user", content: "hi" }], { timeout: 180_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map((call) => call[2])).toEqual([180_000, 180_000]);
    expect(res.costUsd).toBeCloseTo(0.0087);
    expect(res.settlement).toMatchObject({ scheme: "exact", transaction: "0xpaid", network: "eip155:8453" });
    expect(client.getSpending().totalUsd).toBeCloseTo(0.0087);
  });

  it("without options.timeout the client's timeout applies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(buildChatResponse())));
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY, timeout: 1234 });
    const timers = vi.spyOn(globalThis, "setTimeout");
    await client.chatCompletion("nvidia/nemotron-3.5-lightning", [{ role: "user", content: "hi" }]);
    expect(timers.mock.calls.some((call) => call[1] === 1234)).toBe(true);
  });

  it("Solana threads options.timeout to the unpaid and the paid request", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    vi.spyOn(client as any, "readPaymentRequired").mockResolvedValue({ x402Version: 2, accepts: [] });
    vi.spyOn(client as any, "signExactPayment").mockResolvedValue({ paymentPayload: "signed", costUsd: 0.0087 });
    const fetchSpy = vi
      .spyOn(client as any, "fetchWithTimeout")
      .mockResolvedValueOnce(new Response("{}", { status: 402 }))
      .mockResolvedValueOnce(jsonResponse(buildChatResponse()));
    await client.chatCompletion("xai/grok-4.3", [{ role: "user", content: "hi" }], { timeout: 180_000 });
    expect(fetchSpy.mock.calls.map((call) => call[2])).toEqual([180_000, 180_000]);
  });
});

describe("smart routing with search stays on xai/*", () => {
  // The REAL router (bundled router-core) against a synthetic catalog.
  const pricing = () =>
    new Map([
      ["google/gemini-3.5-flash", { inputPrice: 0.5, outputPrice: 3 }],
      ["anthropic/claude-sonnet-5", { inputPrice: 3, outputPrice: 15 }],
      ["xai/grok-4.3", { inputPrice: 1.25, outputPrice: 2.5 }],
      ["xai/grok-4.5", { inputPrice: 2, outputPrice: 6 }],
    ]);
  const hardPrompt =
    "Prove that there are infinitely many primes, then derive the prime number theorem step by step with rigorous analysis.";

  it("detects search the way the request body does", () => {
    expect(requestsSearch({ tools: [{ type: "x_search" }] })).toBe(true);
    expect(requestsSearch({ tools: [{ type: "web_search" }] })).toBe(true);
    expect(requestsSearch({ tools: [{ type: "function", function: { name: "f" } }] })).toBe(false);
    expect(requestsSearch({ searchParameters: { mode: "auto" } })).toBe(true);
    expect(requestsSearch({ searchParameters: {} })).toBe(true);
    expect(requestsSearch({ searchParameters: { mode: "off" } })).toBe(false);
    // searchParameters takes precedence over the shortcut, as in the body.
    expect(requestsSearch({ search: true, searchParameters: { mode: "off" } })).toBe(false);
    expect(requestsSearch({ search: true })).toBe(true);
    expect(requestsSearch({})).toBe(false);
  });

  it("keeps only the xai/* candidates, in the router's order", () => {
    const plain = routeWithCatalog(hardPrompt, undefined, 4000, pricing(), { routingProfile: "premium" });
    const xaiInRouterOrder = plain.candidates!.filter((id) => id.startsWith("xai/"));
    expect(xaiInRouterOrder.length).toBeGreaterThan(1);
    expect(plain.candidates!.some((id) => !id.startsWith("xai/"))).toBe(true);

    for (const options of [{ tools: [{ type: "x_search" as const }] }, { searchParameters: { mode: "on" as const } }, { search: true }]) {
      const decision = routeWithCatalog(hardPrompt, undefined, 4000, pricing(), { routingProfile: "premium", ...options });
      expect(decision.candidates).toEqual(xaiInRouterOrder);
      expect(decision.model).toBe(xaiInRouterOrder[0]);
      expect(decision.fallbacks).toEqual(xaiInRouterOrder.slice(1));
    }
  });

  it("leaves routing alone when search is off", () => {
    const plain = routeWithCatalog(hardPrompt, undefined, 4000, pricing(), { routingProfile: "premium" });
    const off = routeWithCatalog(hardPrompt, undefined, 4000, pricing(), {
      routingProfile: "premium",
      searchParameters: { mode: "off" },
    });
    expect(off.candidates).toEqual(plain.candidates);
  });

  it("throws before any request when the route has no xai/* candidate", () => {
    expect(() =>
      routeWithCatalog("Name the capital of France. One word.", undefined, 50, pricing(), {
        routingProfile: "eco",
        tools: [{ type: "x_search" }],
      }),
    ).toThrow(/xai\/\* models only/);
  });

  it("both clients refuse a search smartChatCompletion with no xai/* route, sending nothing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(buildChatResponse()));
    vi.stubGlobal("fetch", fetchMock);
    for (const client of [new LLMClient({ privateKey: TEST_PRIVATE_KEY }), new SolanaLLMClient({ privateKey: TEST_BS58_KEY })]) {
      vi.spyOn(client as any, "getModelPricing").mockResolvedValue(pricing());
      await expect(
        client.smartChatCompletion([{ role: "user", content: "Name the capital of France. One word." }], {
          routingProfile: "eco",
          tools: [{ type: "x_search", allowedXHandles: ["xai"] }],
        }),
      ).rejects.toThrow(/xai\/\* models only/);
      await expect(
        client.smartChat("Name the capital of France. One word.", { routingProfile: "eco", search: true }),
      ).rejects.toThrow(/xai\/\* models only/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("both clients route a search smartChatCompletion to xai/* with xai/* fallbacks", async () => {
    for (const client of [new LLMClient({ privateKey: TEST_PRIVATE_KEY }), new SolanaLLMClient({ privateKey: TEST_BS58_KEY })]) {
      vi.spyOn(client as any, "getModelPricing").mockResolvedValue(pricing());
      const spy = vi.spyOn(client as any, "requestWithPayment").mockResolvedValue(buildChatResponse());
      const result = await client.smartChatCompletion([{ role: "user", content: hardPrompt }], {
        routingProfile: "premium",
        maxOutputTokens: 4000,
        searchParameters: { mode: "on", sources: [{ type: "x" }] },
        timeout: 90_000,
      });
      expect(result.model.startsWith("xai/")).toBe(true);
      expect(result.routing.fallbacks?.every((id) => id.startsWith("xai/"))).toBe(true);
      const [, body, timeout] = spy.mock.calls[0] as [string, Record<string, unknown>, number];
      expect(body.model).toBe(result.model);
      expect(timeout).toBe(90_000);
    }
  });
});
