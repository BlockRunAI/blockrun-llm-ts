// SolanaLLMClient half of settlement-skipped-booking.test.ts: every site that
// books a paid Solana call goes through recordSettlement(costUsd, response),
// which books nothing when the gateway skipped settlement (X-Settlement-Skipped
// with any reason, or X-Payment-Waived) and the full charge otherwise,
// including on `X-Payment-Settled: false` alone (still owed). Signing is
// stubbed (it needs a Solana RPC); every request goes through a faked `fetch`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaLLMClient } from "../../src/solana-client";
import { buildChatResponse } from "../helpers/testHelpers";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";
const COST_USD = 0.004;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

type Headers_ = Record<string, string>;

const SKIPPED: Array<[string, Headers_]> = [
  [
    "sol pm empty result (X-Settlement-Skipped: empty-result + X-Payment-Waived + X-Payment-Settled: false)",
    { "X-Payment-Waived": "empty-result", "X-Payment-Settled": "false", "X-Settlement-Skipped": "empty-result" },
  ],
  ["sol rpc unexecuted (X-Settlement-Skipped: unexecuted + X-Payment-Settled: false)", { "X-Payment-Settled": "false", "X-Settlement-Skipped": "unexecuted" }],
  ["chat free fallback (X-Settlement-Skipped: free-fallback)", { "X-Settlement-Skipped": "free-fallback" }],
  ["X-Payment-Waived alone", { "X-Payment-Waived": "empty-result" }],
];

const BOOKED: Array<[string, Headers_]> = [
  ["settled (PAYMENT-RESPONSE with a transaction)", { "PAYMENT-RESPONSE": b64({ success: true, transaction: "5sig", network: "solana:mainnet" }) }],
  ["X-Payment-Settled: false alone (still owed)", { "X-Payment-Settled": "false" }],
];

const CHALLENGE = {
  x402Version: 2,
  accepts: [{
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    amount: "4000",
    payTo: "So11111111111111111111111111111111111111112",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    maxTimeoutSeconds: 300,
    extra: { feePayer: "So11111111111111111111111111111111111111112" },
  }],
};

type Call = { method: string; url: string; paid: boolean };

function stubFetch(handler: (call: Call) => Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const h = new Headers(init?.headers);
    return handler({ method: init?.method ?? "GET", url: String(input), paid: h.get("PAYMENT-SIGNATURE") !== null });
  });
}

const json = (body: unknown, headers: Headers_ = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const challenge = () => json(CHALLENGE, {}, 402);

/** A client whose exact signers return a fixed payload at COST_USD. */
function client(): SolanaLLMClient {
  const c = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
  vi.spyOn(c as unknown as { signPaymentFrom402: () => unknown }, "signPaymentFrom402")
    .mockResolvedValue({ paymentPayload: "signed", costUsd: COST_USD });
  vi.spyOn(c as unknown as { signExactPayment: () => unknown }, "signExactPayment")
    .mockResolvedValue({ paymentPayload: "signed", costUsd: COST_USD });
  return c;
}

type Site = { name: string; run: (headers: Headers_) => Promise<{ totalUsd: number; calls: number }> };

const SITES: Site[] = [
  {
    name: "pm GET (handleGetPaymentAndRetryRaw)",
    run: async (headers) => {
      const c = client();
      stubFetch((call) => (call.paid ? json({ data: [] }, headers) : challenge()));
      await c.pm("markets/search", { q: "nothing-matches" });
      return c.getSpending();
    },
  },
  {
    name: "pmQuery POST (handlePaymentAndRetryRaw, 200)",
    run: async (headers) => {
      const c = client();
      stubFetch((call) => (call.paid ? json({ data: [] }, headers) : challenge()));
      await c.pmQuery("polymarket/wallet/identities", { addresses: ["0xabc"] });
      return c.getSpending();
    },
  },
  {
    name: "image POST answered 202 (handlePaymentAndRetryRaw, settles at POST)",
    run: async (headers) => {
      const c = client();
      vi.spyOn(c as unknown as { followSolanaJob: () => unknown }, "followSolanaJob").mockResolvedValue({ data: [] });
      stubFetch((call) =>
        call.paid ? json({ id: "j1", poll_url: "/v1/images/generations/j1", status: "queued" }, headers, 202) : challenge()
      );
      await (c as unknown as {
        requestWithPaymentRaw(e: string, b: Record<string, unknown>): Promise<unknown>;
      }).requestWithPaymentRaw("/v1/images/generations", { prompt: "a cat" });
      return c.getSpending();
    },
  },
  {
    name: "chat exact (handlePaymentAndRetry)",
    run: async (headers) => {
      const c = client();
      stubFetch((call) => (call.paid ? json(buildChatResponse(), headers) : challenge()));
      const res = await c.chatCompletion("openai/gpt-4o-mini", [{ role: "user", content: "hi" }]);
      expect(res.costUsd).toBeCloseTo(c.getSpending().totalUsd, 10);
      return c.getSpending();
    },
  },
  {
    name: "chat batch (batchPayer paid)",
    run: async (headers) => {
      const c = client();
      (c as unknown as { batchPayer: unknown }).batchPayer = {
        closeFence: async () => undefined,
        pay: async () => ({ kind: "paid", response: json(buildChatResponse(), headers), chargedUsd: COST_USD }),
      };
      stubFetch(() => challenge());
      const res = await c.chatCompletion("openai/gpt-4o-mini", [{ role: "user", content: "hi" }]);
      expect(res.costUsd).toBeCloseTo(c.getSpending().totalUsd, 10);
      return c.getSpending();
    },
  },
  {
    name: "stream (openPaidStream)",
    run: async (headers) => {
      const c = client();
      stubFetch((call) =>
        call.paid
          ? new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream", ...headers } })
          : challenge()
      );
      for await (const _ of c.stream("/v1/chat/completions", { model: "x" })) { /* drain */ }
      return c.getSpending();
    },
  },
  {
    name: "video delivered on the paid completion poll (followSolanaJob deliver)",
    run: async (headers) => {
      const c = client();
      stubFetch((call) =>
        call.paid
          ? json({ status: "completed", data: [{ url: "https://x/v.mp4" }] }, headers)
          : json({ ...CHALLENGE, status: "completed" }, {}, 402)
      );
      await (c as unknown as {
        followSolanaJob(s: Record<string, unknown>, b: number, k: string, i: number): Promise<unknown>;
      }).followSolanaJob({ id: "v", poll_url: "/api/v1/videos/generations/v" }, 10_000, "video", 1);
      return c.getSpending();
    },
  },
];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(SITES)("SolanaLLMClient $name", (site) => {
  it.each(SKIPPED)("books $0 and does not throw: %s", async (_name, headers) => {
    expect(await site.run(headers)).toEqual({ totalUsd: 0, calls: 0 });
  });

  it.each(BOOKED)("books the full charge: %s", async (_name, headers) => {
    const spending = await site.run(headers);
    expect(spending.calls).toBe(1);
    expect(spending.totalUsd).toBeCloseTo(COST_USD, 10);
  });
});
