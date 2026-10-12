import { describe, it, expect, vi, afterEach } from "vitest";
import { LLMClient } from "../../src/client";
import { SolanaLLMClient } from "../../src/solana-client";
import { TEST_PRIVATE_KEY, buildChatResponse } from "../helpers/testHelpers";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

/**
 * The headers the Base / Arc gateway sends when a paid request was served by a
 * free fallback (blockrun src/app/api/v1/chat/completions/route.ts): settlement
 * is skipped (`txHash: ""`), PAYMENT-RESPONSE still says success with an empty
 * transaction, no X-Payment-Receipt, and X-Settlement-Skipped names why.
 */
const freeFallbackHeaders = {
  "content-type": "application/json",
  "PAYMENT-RESPONSE": b64({ success: true, transaction: "", network: "eip155:8453", payer: "0xpayer" }),
  "X-Settlement-Skipped": "free-fallback",
  "X-Fallback-Used": "true",
  "X-Fallback-Model": "nvidia/nemotron-3.5-lightning",
};

describe("a paid request served by a free fallback books nothing", () => {
  it("LLMClient: costUsd 0, settlement.skipped, nothing added to getSpending() or the cost log", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const recordCost = vi.spyOn(client as any, "recordCost").mockImplementation(() => undefined);
    vi.spyOn(client as any, "signFrom402").mockResolvedValue({
      paymentPayload: "signed",
      details: { amount: "8700", network: "eip155:8453" },
    });
    vi.spyOn(client as any, "fetchWithTimeout")
      .mockResolvedValueOnce(new Response("{}", { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(buildChatResponse()), { status: 200, headers: freeFallbackHeaders }));

    const res = await client.chatCompletion("anthropic/claude-sonnet-5", [{ role: "user", content: "hi" }]);

    expect(res.costUsd).toBe(0);
    expect(res.settlement).toEqual({ scheme: "exact", quotedUsd: 0.0087, network: "eip155:8453", skipped: "free-fallback" });
    expect(res.fallback).toEqual({ used: true, model: "nvidia/nemotron-3.5-lightning", settlementSkipped: true });
    expect(client.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("LLMClient: the same holds when the answer comes on the 502/503 resend", async () => {
    vi.useFakeTimers();
    try {
      const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
      vi.spyOn(client as any, "recordCost").mockImplementation(() => undefined);
      vi.spyOn(client as any, "signFrom402").mockResolvedValue({
        paymentPayload: "signed",
        details: { amount: "8700", network: "eip155:8453" },
      });
      vi.spyOn(client as any, "fetchWithTimeout")
        .mockResolvedValueOnce(new Response("{}", { status: 402 }))
        .mockResolvedValueOnce(new Response("{}", { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(buildChatResponse()), { status: 200, headers: freeFallbackHeaders }));

      const pending = client.chatCompletion("anthropic/claude-sonnet-5", [{ role: "user", content: "hi" }]);
      await vi.runAllTimersAsync();
      const res = await pending;

      expect(res.costUsd).toBe(0);
      expect(res.settlement?.skipped).toBe("free-fallback");
      expect(client.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("control: a settled paid call (no X-Settlement-Skipped) still books its price", async () => {
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const recordCost = vi.spyOn(client as any, "recordCost").mockImplementation(() => undefined);
    vi.spyOn(client as any, "signFrom402").mockResolvedValue({
      paymentPayload: "signed",
      details: { amount: "8700", network: "eip155:8453" },
    });
    const { "X-Settlement-Skipped": _skipped, ...settled } = freeFallbackHeaders;
    vi.spyOn(client as any, "fetchWithTimeout")
      .mockResolvedValueOnce(new Response("{}", { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(buildChatResponse()), {
        status: 200,
        headers: { ...settled, "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xpaid", network: "eip155:8453" }) },
      }));

    const res = await client.chatCompletion("anthropic/claude-sonnet-5", [{ role: "user", content: "hi" }]);

    expect(res.costUsd).toBeCloseTo(0.0087);
    expect(res.settlement?.skipped).toBeUndefined();
    expect(client.getSpending().totalUsd).toBeCloseTo(0.0087);
    expect(recordCost).toHaveBeenCalledTimes(1);
  });

  it("SolanaLLMClient: an exact answer with X-Settlement-Skipped is not booked either", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    vi.spyOn(client as any, "readPaymentRequired").mockResolvedValue({ x402Version: 2, accepts: [] });
    vi.spyOn(client as any, "signExactPayment").mockResolvedValue({ paymentPayload: "signed", costUsd: 0.0087 });
    vi.spyOn(client as any, "fetchWithTimeout")
      .mockResolvedValueOnce(new Response("{}", { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(buildChatResponse()), {
        status: 200,
        headers: { ...freeFallbackHeaders, "PAYMENT-RESPONSE": b64({ success: true, transaction: "", network: "solana:mainnet" }) },
      }));

    const res = await client.chatCompletion("anthropic/claude-sonnet-5", [{ role: "user", content: "hi" }]);

    expect(res.costUsd).toBe(0);
    expect(res.settlement).toMatchObject({ scheme: "exact", quotedUsd: 0.0087, skipped: "free-fallback" });
    expect(client.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
  });
});
