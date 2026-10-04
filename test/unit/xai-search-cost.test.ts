import { describe, it, expect, vi, afterEach } from "vitest";
import { SolanaLLMClient } from "../../src/solana-client";
import { toWireSearchParameters, toWireTools } from "../../src/search-wire";
import { readSettlement } from "../../src/receipt";
import { buildChatResponse } from "../helpers/testHelpers";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
