// The gateways serve some paid requests WITHOUT settling them, and say so:
//   sol  /v1/pm/markets/search, empty result → X-Settlement-Skipped: empty-result
//        (+ X-Payment-Waived: empty-result, X-Payment-Settled: false, no PAYMENT-RESPONSE)
//   sol  /v1/rpc/*, JSON-RPC never executed  → X-Settlement-Skipped: unexecuted
//   chat, free fallback served the call      → X-Settlement-Skipped: free-fallback
//   base /v1/pm/*, empty result              → X-Payment-Waived: empty-result (only)
// Nothing moved on chain, so nothing may be booked: not in getSpending(), not in
// the cost log. `X-Payment-Settled: false` ALONE is different: settlement did
// not land before the response went out, and the payment is still owed.
//
// Every site that books a paid EVM call is driven here through its public
// method against a faked `fetch` (signing is the real EVM signer), once per
// header shape. The Solana client's sites are in settlement-skipped-solana.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/client";
import { BlockrunClient } from "../../src/blockrun";
import { VideoClient } from "../../src/video";
import { VoiceClient } from "../../src/voice";
import { SpeechClient } from "../../src/speech";
import { MusicClient } from "../../src/music";
import { RpcClient } from "../../src/rpc";
import { PortraitClient } from "../../src/portrait";
import { PhoneClient } from "../../src/phone";
import { settlementSkipped, settlementSkipReason } from "../../src/receipt";
import { TEST_PRIVATE_KEY, buildChatResponse, buildPaymentRequiredResponse } from "../helpers/testHelpers";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

/** Atomic USDC the 402 quotes, and what a booked call adds to getSpending(). */
const QUOTE_ATOMIC = "4000";
const QUOTE_USD = 0.004;

type Headers_ = Record<string, string>;

/** Paid 200s the gateway did NOT settle: each must book $0. */
const SKIPPED: Array<[string, Headers_]> = [
  [
    "sol pm empty result (X-Settlement-Skipped: empty-result + X-Payment-Waived + X-Payment-Settled: false)",
    { "X-Payment-Waived": "empty-result", "X-Payment-Settled": "false", "X-Settlement-Skipped": "empty-result" },
  ],
  ["sol rpc unexecuted (X-Settlement-Skipped: unexecuted + X-Payment-Settled: false)", { "X-Payment-Settled": "false", "X-Settlement-Skipped": "unexecuted" }],
  ["chat free fallback (X-Settlement-Skipped: free-fallback)", { "X-Settlement-Skipped": "free-fallback" }],
  ["base pm empty result (X-Payment-Waived alone)", { "X-Payment-Waived": "empty-result" }],
  ["a reason the SDK has never seen (X-Settlement-Skipped: some-future-reason)", { "X-Settlement-Skipped": "some-future-reason" }],
];

/** Paid 200s that still owe the payment: each must book the full quote. */
const BOOKED: Array<[string, Headers_]> = [
  ["settled (PAYMENT-RESPONSE with a transaction)", { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xpaid", network: "eip155:8453" }) }],
  ["X-Payment-Settled: false alone (settlement did not land in time: still owed)", { "X-Payment-Settled": "false" }],
  ["empty X-Settlement-Skipped / blank X-Payment-Waived (no reason named)", { "X-Settlement-Skipped": "", "X-Payment-Waived": " " }],
];

type Call = { method: string; url: string; paid: boolean };
let calls: Call[];

/** Route every request through `handler`; the 402 challenge is shared. */
function stubFetch(handler: (call: Call, n: number) => Response) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(input),
      paid: new Headers(init?.headers).get("PAYMENT-SIGNATURE") !== null,
    };
    calls.push(call);
    return handler(call, calls.length);
  });
}

function challenge(resourceUrl: string): Response {
  return new Response("{}", {
    status: 402,
    headers: {
      "payment-required": buildPaymentRequiredResponse({
        amount: QUOTE_ATOMIC,
        resource: { url: resourceUrl, description: "test" },
      }),
    },
  });
}

const json = (body: unknown, headers: Headers_ = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * One booking site: drives a paid call whose PAID answer carries `headers`,
 * and returns the client's spending plus what the site books when it books.
 */
type Site = {
  name: string;
  expectUsd: number;
  run: (headers: Headers_) => Promise<{ spending: { totalUsd: number; calls: number }; logged?: number }>;
};

/** Run `fn` under fake timers: the 502/503 resend and the poll loops sleep. */
async function withTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = fn();
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

function llm() {
  const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
  const recordCost = vi.spyOn(client as unknown as { recordCost: () => void }, "recordCost").mockImplementation(() => undefined);
  return { client, recordCost };
}

const API = "https://blockrun.ai/api";

const SITES: Site[] = [
  {
    name: "LLMClient raw GET (pm → getWithPaymentRaw → handleGetPaymentAndRetryRaw)",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const { client, recordCost } = llm();
      stubFetch((c) => (c.paid ? json({ data: [] }, headers) : challenge(`${API}/v1/pm/markets/search`)));
      await client.pm("markets/search", { q: "nothing-matches" });
      return { spending: client.getSpending(), logged: recordCost.mock.calls.length };
    },
  },
  {
    name: "LLMClient raw GET, answered on the 502/503 resend",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const { client, recordCost } = llm();
      let paidSends = 0;
      stubFetch((c) => {
        if (!c.paid) return challenge(`${API}/v1/pm/markets/search`);
        return ++paidSends === 1 ? json({ error: "busy" }, {}, 503) : json({ data: [] }, headers);
      });
      await withTimers(() => client.pm("markets/search", { q: "x" }));
      return { spending: client.getSpending(), logged: recordCost.mock.calls.length };
    },
  },
  {
    name: "LLMClient raw POST (pmQuery → requestWithPaymentRaw → handlePaymentAndRetryRaw)",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const { client, recordCost } = llm();
      stubFetch((c) => (c.paid ? json({ data: [] }, headers) : challenge(`${API}/v1/pm/polymarket/wallet/identities`)));
      await client.pmQuery("polymarket/wallet/identities", { addresses: ["0xabc"] });
      return { spending: client.getSpending(), logged: recordCost.mock.calls.length };
    },
  },
  {
    name: "LLMClient raw POST, answered on the 502/503 resend",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const { client, recordCost } = llm();
      let paidSends = 0;
      stubFetch((c) => {
        if (!c.paid) return challenge(`${API}/v1/pm/polymarket/wallet/identities`);
        return ++paidSends === 1 ? json({ error: "busy" }, {}, 502) : json({ data: [] }, headers);
      });
      await withTimers(() => client.pmQuery("polymarket/wallet/identities", { addresses: ["0xabc"] }));
      return { spending: client.getSpending(), logged: recordCost.mock.calls.length };
    },
  },
  {
    name: "LLMClient chat (bookPaid)",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const { client, recordCost } = llm();
      stubFetch((c) => (c.paid ? json(buildChatResponse(), headers) : challenge(`${API}/v1/chat/completions`)));
      const res = await client.chatCompletion("openai/gpt-4o-mini", [{ role: "user", content: "hi" }]);
      // costUsd always equals what was booked.
      expect(res.costUsd).toBeCloseTo(client.getSpending().totalUsd, 10);
      return { spending: client.getSpending(), logged: recordCost.mock.calls.length };
    },
  },
  {
    name: "LLMClient chat, answered on the 502/503 resend (bookPaid)",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const { client, recordCost } = llm();
      let paidSends = 0;
      stubFetch((c) => {
        if (!c.paid) return challenge(`${API}/v1/chat/completions`);
        return ++paidSends === 1 ? json({ error: "busy" }, {}, 503) : json(buildChatResponse(), headers);
      });
      await withTimers(() => client.chatCompletion("openai/gpt-4o-mini", [{ role: "user", content: "hi" }]));
      return { spending: client.getSpending(), logged: recordCost.mock.calls.length };
    },
  },
  {
    name: "LLMClient chatCompletionStream (402 → sign → stream)",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const { client } = llm();
      stubFetch((c) =>
        c.paid
          ? new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream", ...headers } })
          : challenge(`${API}/v1/chat/completions`)
      );
      await client.chatCompletionStream("openai/gpt-4o-mini", [{ role: "user", content: "gm" }]);
      return { spending: client.getSpending() };
    },
  },
  {
    name: "LLMClient chatCompletionStream pre-auth hit (cached terms, no 402)",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const { client } = llm();
      // First stream: a normal settled call that warms the pre-auth cache.
      stubFetch((c) =>
        c.paid
          ? new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
          : challenge(`${API}/v1/chat/completions`)
      );
      await client.chatCompletionStream("openai/gpt-4o-mini", [{ role: "user", content: "gm" }]);
      const warmed = client.getSpending().totalUsd;
      vi.restoreAllMocks();
      // Second stream: the pre-auth hit, answered with `headers`.
      stubFetch((c) => {
        expect(c.paid).toBe(true); // one signed request, no 402 round trip
        return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
      });
      await client.chatCompletionStream("openai/gpt-4o-mini", [{ role: "user", content: "gm" }]);
      expect(calls).toHaveLength(1);
      const s = client.getSpending();
      return { spending: { totalUsd: s.totalUsd - warmed, calls: s.calls - 1 } };
    },
  },
  {
    name: "BlockrunClient get (request → recordSpending)",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => (c.paid ? json({ data: [] }, headers) : challenge(`${API}/v1/pm/markets/search`)));
      await client.get("/v1/pm/markets/search", { q: "x" });
      return { spending: client.getSpending() };
    },
  },
  {
    name: "BlockrunClient post (request → recordSpending)",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => (c.paid ? json({ jsonrpc: "2.0", id: 1, error: { code: -32600 } }, headers) : challenge(`${API}/v1/rpc/base`)));
      await client.post("/v1/rpc/base", { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" });
      return { spending: client.getSpending() };
    },
  },
  {
    name: "BlockrunClient stream",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) =>
        c.paid
          ? new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream", ...headers } })
          : challenge(`${API}/v1/chat/completions`)
      );
      for await (const _ of client.stream("/v1/chat/completions", { model: "x", stream: true })) { /* drain */ }
      return { spending: client.getSpending() };
    },
  },
  {
    name: "BlockrunClient poll, answered 200 on submit",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => (c.paid ? json({ data: [{ url: "u" }] }, headers) : challenge(`${API}/v1/images/generations`)));
      await client.poll("/v1/images/generations", { prompt: "x" });
      return { spending: client.getSpending() };
    },
  },
  {
    name: "BlockrunClient poll, completed on a poll",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => {
        if (!c.paid) return challenge(`${API}/v1/videos/generations`);
        if (c.method === "POST") return json({ id: "j1", poll_url: "/v1/videos/generations/j1", status: "queued" }, {}, 202);
        return json({ id: "j1", status: "completed", data: [{ url: "u" }] }, headers);
      });
      await withTimers(() => client.poll("/v1/videos/generations", { prompt: "x" }, { intervalMs: 1 }));
      return { spending: client.getSpending() };
    },
  },
  {
    name: "VideoClient generate (completed poll)",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new VideoClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => {
        if (c.method === "POST") {
          return c.paid
            ? json({ id: "v1", status: "queued", poll_url: "/api/v1/videos/generations/v1" }, {}, 202)
            : challenge(`${API}/v1/videos/generations`);
        }
        return json({ status: "completed", data: [{ url: "https://x/v.mp4" }] }, headers);
      });
      await withTimers(() => client.generate("a red apple"));
      return { spending: client.getSpending() };
    },
  },
  {
    name: "VoiceClient call",
    expectUsd: 0.54,
    run: async (headers) => {
      const client = new VoiceClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => (c.paid ? json({ call_id: "c1", status: "queued" }, headers) : challenge(`${API}/v1/voice/call`)));
      await client.call({ to: "+14155550123", task: "Say hello and hang up." });
      return { spending: client.getSpending() };
    },
  },
  {
    name: "SpeechClient generate",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new SpeechClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => (c.paid ? json({ data: [{ url: "u" }] }, headers) : challenge(`${API}/v1/audio/speech`)));
      await client.generate("hello");
      return { spending: client.getSpending() };
    },
  },
  {
    name: "MusicClient generate",
    expectUsd: 0.1575,
    run: async (headers) => {
      const client = new MusicClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => (c.paid ? json({ data: [{ url: "u" }] }, headers) : challenge(`${API}/v1/audio/generations`)));
      await client.generate("lofi");
      return { spending: client.getSpending() };
    },
  },
  {
    name: "RpcClient call",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new RpcClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => (c.paid ? json({ jsonrpc: "2.0", id: 1, result: "0x1" }, headers) : challenge(`${API}/v1/rpc/ethereum`)));
      await client.call("ethereum", "eth_blockNumber");
      return { spending: client.getSpending() };
    },
  },
  {
    name: "PortraitClient enroll",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new PortraitClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => (c.paid ? json({ asset_id: "ta_abc" }, headers) : challenge(`${API}/v1/portrait/enroll`)));
      await client.enroll({ name: "me", imageUrl: "https://x/me.png" });
      return { spending: client.getSpending() };
    },
  },
  {
    name: "PhoneClient lookup",
    expectUsd: QUOTE_USD,
    run: async (headers) => {
      const client = new PhoneClient({ privateKey: TEST_PRIVATE_KEY });
      stubFetch((c) => (c.paid ? json({ valid: true }, headers) : challenge(`${API}/v1/phone/lookup`)));
      await client.lookup("+14155550123");
      return { spending: client.getSpending() };
    },
  },
];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("settlementSkipped / settlementSkipReason", () => {
  const r = (headers: Headers_) => new Response("{}", { status: 200, headers });

  it.each(SKIPPED)("skipped: %s", (_name, headers) => {
    expect(settlementSkipped(r(headers))).toBe(true);
  });

  it.each(BOOKED)("not skipped: %s", (_name, headers) => {
    expect(settlementSkipped(r(headers))).toBe(false);
    expect(settlementSkipReason(r(headers))).toBeUndefined();
  });

  it("names X-Settlement-Skipped's reason first, else X-Payment-Waived's", () => {
    expect(settlementSkipReason(r({ "X-Settlement-Skipped": "free-fallback" }))).toBe("free-fallback");
    expect(settlementSkipReason(r({ "X-Settlement-Skipped": "unexecuted", "X-Payment-Waived": "empty-result" }))).toBe("unexecuted");
    expect(settlementSkipReason(r({ "X-Payment-Waived": "empty-result" }))).toBe("empty-result");
    expect(settlementSkipReason(r({ "X-Settlement-Skipped": "", "X-Payment-Waived": "empty-result" }))).toBe("empty-result");
  });
});

describe.each(SITES)("$name", (site) => {
  it.each(SKIPPED)("books $0 and does not throw: %s", async (_name, headers) => {
    const { spending, logged } = await site.run(headers);
    expect(spending).toEqual({ totalUsd: 0, calls: 0 });
    if (logged !== undefined) expect(logged).toBe(0);
  });

  it.each(BOOKED)("books the full price: %s", async (_name, headers) => {
    const { spending, logged } = await site.run(headers);
    expect(spending.calls).toBe(1);
    expect(spending.totalUsd).toBeCloseTo(site.expectUsd, 10);
    if (logged !== undefined) expect(logged).toBe(1);
  });
});

describe("chat reports the skip reason on the response", () => {
  it("costUsd 0 and settlement.skipped names the gateway's reason", async () => {
    const { client } = llm();
    stubFetch((c) =>
      c.paid
        ? json(buildChatResponse(), { "X-Settlement-Skipped": "unexecuted", "X-Payment-Settled": "false" })
        : challenge(`${API}/v1/chat/completions`)
    );
    const res = await client.chatCompletion("openai/gpt-4o-mini", [{ role: "user", content: "hi" }]);
    expect(res.costUsd).toBe(0);
    expect(res.settlement).toMatchObject({ scheme: "exact", quotedUsd: QUOTE_USD, skipped: "unexecuted" });
  });

  it("X-Payment-Settled: false alone is booked and not marked skipped", async () => {
    const { client } = llm();
    stubFetch((c) => (c.paid ? json(buildChatResponse(), { "X-Payment-Settled": "false" }) : challenge(`${API}/v1/chat/completions`)));
    const res = await client.chatCompletion("openai/gpt-4o-mini", [{ role: "user", content: "hi" }]);
    expect(res.costUsd).toBeCloseTo(QUOTE_USD, 10);
    expect(res.settlement?.skipped).toBeUndefined();
  });
});
