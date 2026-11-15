// decisions(): typed judgments (POST /v1/decisions) on every rail.
// LLMClient signs EVM payments locally (offline); SolanaLLMClient's signers
// are stubbed (they need an RPC). Every request goes through a faked fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/client";
import { SolanaLLMClient } from "../../src/solana-client";
import { OpenAI } from "../../src/openai-compat";
import { buildDecisionsBody, DECISIONS_DEFAULT_MODEL } from "../../src/decisions";
import { APIError, retryDisposition, type DecisionsRequest } from "../../src/types";
import { TEST_PRIVATE_KEY, buildPaymentRequiredResponse } from "../helpers/testHelpers";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

const REQUEST: DecisionsRequest = {
  input: "My card was charged twice.",
  questions: [
    { type: "predicate", name: "urgent", instructions: "Does this need a reply today?" },
    { type: "choice", name: "team", instructions: "Which team?", choices: [{ value: "billing" }, { value: "none" }] },
    { type: "score", name: "anger", instructions: "How upset?", levels: [{ label: "calm" }, { label: "furious" }] },
  ],
};

// The shape gpt-6-luna answered with on sol.blockrun.ai, 2026-11-15.
const ANSWER = {
  model: "gpt-6-luna",
  answers: [
    { type: "predicate", name: "urgent", probability: 0.85 },
    {
      type: "choice", name: "team", choice: "billing", confidence: 1,
      probabilities: [{ value: "billing", probability: 1 }, { value: "none", probability: 0 }],
    },
    {
      type: "score", name: "anger", score: 1, confidence: 1,
      probabilities: [{ value: 0, label: "calm", probability: 0 }, { value: 1, label: "furious", probability: 1 }],
    },
  ],
  usage: { input_tokens: 386, output_tokens: 0, total_tokens: 386 },
};

type Call = { url: string; method: string; headers: Headers; body: unknown };
let calls: Call[];

function stubFetch(handler: (call: Call) => Response) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const paid = (c: Call) => c.headers.get("PAYMENT-SIGNATURE") !== null;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("buildDecisionsBody", () => {
  it("defaults the model and forwards the request as given", () => {
    const body = buildDecisionsBody({ ...REQUEST, metadata: { ticket: "42" } });
    expect(body.model).toBe(DECISIONS_DEFAULT_MODEL);
    expect(body.questions).toEqual(REQUEST.questions);
    expect(body.metadata).toEqual({ ticket: "42" });
  });

  it("keeps a caller's model", () => {
    expect(buildDecisionsBody({ ...REQUEST, model: "openai/gpt-6-luna" }).model).toBe("openai/gpt-6-luna");
  });

  it.each([
    ["an empty input", { ...REQUEST, input: "" }, /input/],
    ["an empty message array", { ...REQUEST, input: [] }, /input/],
    ["no questions", { ...REQUEST, questions: [] }, /questions/],
    ["an unknown type", { ...REQUEST, questions: [{ type: "rank", name: "a", instructions: "x" }] }, /type/],
    ["a question without a name", { ...REQUEST, questions: [{ type: "predicate", name: "", instructions: "x" }] }, /name/],
    ["a question without instructions", { ...REQUEST, questions: [{ type: "predicate", name: "a", instructions: "" }] }, /instructions/],
    ["a duplicate name", { ...REQUEST, questions: [REQUEST.questions[0], REQUEST.questions[0]] }, /twice/],
    ["a choice without choices", { ...REQUEST, questions: [{ type: "choice", name: "a", instructions: "x", choices: [] }] }, /choices/],
    ["a score without levels", { ...REQUEST, questions: [{ type: "score", name: "a", instructions: "x", levels: [] }] }, /levels/],
  ])("refuses %s as an unpaid error", (_name, request, message) => {
    let thrown: unknown;
    try {
      buildDecisionsBody(request as DecisionsRequest);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toMatch(message);
    expect(retryDisposition(thrown)).toBe("unpaid");
  });
});

describe("LLMClient.decisions (wallet, exact)", () => {
  it("pays the 402 quote and returns the typed answers with their cost", async () => {
    stubFetch((c) =>
      paid(c) ? json(ANSWER) : json({}, 402, { "payment-required": buildPaymentRequiredResponse({ amount: "1069" }) })
    );
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const res = await client.decisions(REQUEST);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://blockrun.ai/api/v1/decisions");
    expect(calls[0].method).toBe("POST");
    expect(calls[1].body).toEqual(calls[0].body);
    expect(calls[0].body).toMatchObject({ model: "gpt-6-luna", input: REQUEST.input, questions: REQUEST.questions });

    expect(res.answers).toEqual(ANSWER.answers);
    expect(res.costUsd).toBeCloseTo(0.001069, 10);
    expect(res.settlement?.scheme).toBe("exact");
    expect(client.getSpending()).toEqual({ totalUsd: 0.001069, calls: 1 });
  });

  it("sends nothing for a malformed request", async () => {
    stubFetch(() => json(ANSWER));
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await expect(client.decisions({ ...REQUEST, questions: [] })).rejects.toThrow(/questions/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the gateway's pre-payment 400 as an unpaid APIError", async () => {
    stubFetch(() => json({ error: { message: "hosted image URLs are not accepted", param: "input" } }, 400));
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    let thrown: unknown;
    try {
      await client.decisions(REQUEST);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).statusCode).toBe(400);
    expect(retryDisposition(thrown)).toBe("unpaid");
    expect(calls.filter(paid)).toHaveLength(0);
    expect(client.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
  });

  it("an error after the payment was sent is paid-or-in-doubt", async () => {
    stubFetch((c) =>
      paid(c) ? json({ error: "upstream" }, 502) : json({}, 402, { "payment-required": buildPaymentRequiredResponse({ amount: "1069" }) })
    );
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    let thrown: unknown;
    try {
      await client.decisions(REQUEST);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(retryDisposition(thrown)).not.toBe("unpaid");
  });
});

describe("LLMClient.decisions (account API key)", () => {
  it("posts to api.blockrun.ai with the key and no payment", async () => {
    stubFetch(() => json(ANSWER));
    const client = new LLMClient({ apiKey: "brk_live_unit_test" });
    const res = await client.decisions(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.blockrun.ai/v1/decisions");
    expect(calls[0].headers.get("authorization")).toBe("Bearer brk_live_unit_test");
    expect(paid(calls[0])).toBe(false);
    expect(res.answers).toEqual(ANSWER.answers);
    expect(res.costUsd).toBeUndefined();
  });
});

describe("SolanaLLMClient.decisions", () => {
  const SOL_CHALLENGE = {
    x402Version: 2,
    accepts: [{
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "1069",
      payTo: "So11111111111111111111111111111111111111112",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      maxTimeoutSeconds: 300,
      extra: { feePayer: "So11111111111111111111111111111111111111112" },
    }],
  };

  function solClient(): SolanaLLMClient {
    const c = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    vi.spyOn(c as unknown as { signExactPayment: () => unknown }, "signExactPayment")
      .mockResolvedValue({ paymentPayload: "signed", costUsd: 0.001069 });
    return c;
  }

  it("pays exact on sol.blockrun.ai", async () => {
    stubFetch((c) => (paid(c) ? json(ANSWER) : json(SOL_CHALLENGE, 402)));
    const client = solClient();
    const res = await client.decisions(REQUEST);

    expect(calls[0].url).toBe("https://sol.blockrun.ai/api/v1/decisions");
    expect(calls[0].body).toMatchObject({ model: "gpt-6-luna", questions: REQUEST.questions });
    expect(res.answers).toEqual(ANSWER.answers);
    expect(res.costUsd).toBeCloseTo(0.001069, 10);
    expect(client.getSpending().calls).toBe(1);
  });

  it("pays with batch settlement when enabled, booking the metered charge", async () => {
    stubFetch(() => json(SOL_CHALLENGE, 402));
    const client = solClient();
    const pay = vi.fn(async () => ({ kind: "paid", response: json(ANSWER), chargedUsd: 0.000039 }));
    (client as unknown as { batchPayer: unknown }).batchPayer = { closeFence: async () => undefined, pay };

    const res = await client.decisions(REQUEST);

    expect(pay).toHaveBeenCalledTimes(1);
    expect(res.costUsd).toBeCloseTo(0.000039, 10);
    expect(res.settlement?.scheme).toBe("batch");
    expect(client.getSpending()).toEqual({ totalUsd: 0.000039, calls: 1 });
  });
});

describe("OpenAI.decisions.create", () => {
  it("is LLMClient.decisions", async () => {
    stubFetch(() => json(ANSWER));
    const client = new OpenAI({ apiKey: "brk_live_unit_test" });
    const res = await client.decisions.create(REQUEST);
    expect(calls[0].url).toBe("https://api.blockrun.ai/v1/decisions");
    expect(res.answers).toEqual(ANSWER.answers);
  });
});
