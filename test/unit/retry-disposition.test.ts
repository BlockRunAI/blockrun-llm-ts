// A fallback model is a new paid request. These pin which failures may move
// on to it: only those of a request that sent nothing chargeable ("unpaid").
// Every pair runs the same failure twice, once before any payment was sent and
// once after, through the real request path of each client with only `fetch`
// (and, on Solana, the exact signer) faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/client";
import { SolanaLLMClient } from "../../src/solana-client";
import { isTransientError } from "../../src/router-adapter";
import { APIError, PaymentError, retryDisposition, withDisposition } from "../../src/types";
import { BatchPaymentUnresolvedError } from "../../src/solana-batch";
import { TEST_PRIVATE_KEY, buildChatResponse, buildPaymentRequiredResponse } from "../helpers/testHelpers";

const SOLANA_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";
const PRIMARY = "primary/model";
const FALLBACK = "fallback/model";

type Answer = () => Response | Promise<Response>;

const ok = (model = FALLBACK): Answer => () => Response.json(buildChatResponse({ model }));
const status = (code: number): Answer => () => Response.json({ error: `status ${code}` }, { status: code });
const timeout: Answer = () => {
  throw new DOMException("The operation was aborted.", "AbortError");
};
const evm402: Answer = () =>
  new Response("{}", { status: 402, headers: { "payment-required": buildPaymentRequiredResponse() } });
const solana402: Answer = () => {
  const body = {
    x402Version: 2,
    resource: { url: "https://sol.blockrun.ai/api/v1/chat/completions", description: "chat" },
    accepts: [
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: "5000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo: "AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA",
        maxTimeoutSeconds: 300,
        extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" },
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body)).toString("base64") },
  });
};

let answers: Answer[];
let calls: Array<{ model: string; paid: boolean; signature?: string }>;

beforeEach(() => {
  answers = [];
  calls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const headers = new Headers(init?.headers);
    const signature = headers.get("PAYMENT-SIGNATURE") ?? undefined;
    calls.push({ model: JSON.parse(String(init?.body)).model, paid: signature !== undefined, signature });
    const next = answers.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  });
  // The EVM client waits 1s before its one 502/503 retry; skip that wait.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn, ms === 1000 ? 0 : ms, ...args)) as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function evmClient(options: { apiKey?: string } = {}) {
  return options.apiKey ? new LLMClient({ apiKey: options.apiKey }) : new LLMClient({ privateKey: TEST_PRIVATE_KEY });
}

function solanaClient() {
  const client = new SolanaLLMClient({ privateKey: SOLANA_KEY, rpcUrl: "https://rpc.test/solana" });
  vi.spyOn(client as unknown as { signExactPayment: () => unknown }, "signExactPayment").mockResolvedValue({
    paymentPayload: "exact-payload",
    costUsd: 0.005,
  });
  return client;
}

const chat = (client: LLMClient | SolanaLLMClient) =>
  client.chatCompletion(PRIMARY, [{ role: "user", content: "gm" }], { fallbackModels: [FALLBACK] });

describe("isTransientError honours the retry disposition", () => {
  it.each([
    ["429", () => new APIError("rate limited", 429)],
    ["503", () => new APIError("unavailable", 503)],
    ["timeout", () => new DOMException("aborted", "AbortError")],
    ["network error", () => new TypeError("fetch failed")],
  ])("moves on after an unpaid %s, never after the same error paid or untagged", (_label, make) => {
    expect(isTransientError(withDisposition(make(), "unpaid"))).toBe(true);
    expect(isTransientError(withDisposition(make(), "paid-or-in-doubt"))).toBe(false);
    // No disposition: the SDK cannot tell, so it does not risk a second charge.
    expect(isTransientError(make())).toBe(false);
  });

  it("never downgrades a paid-or-in-doubt error to unpaid", () => {
    const err = withDisposition(new APIError("after payment", 503), "paid-or-in-doubt");
    expect(retryDisposition(withDisposition(err, "unpaid"))).toBe("paid-or-in-doubt");
  });

  it("keeps PaymentError and non-transient statuses out even when unpaid", () => {
    expect(isTransientError(withDisposition(new PaymentError("no requirements"), "unpaid"))).toBe(false);
    expect(isTransientError(withDisposition(new APIError("bad request", 400), "unpaid"))).toBe(false);
  });

  it("treats BatchPaymentUnresolvedError as paid-or-in-doubt", () => {
    const err = new BatchPaymentUnresolvedError({ reason: "replay_unresolved", wallet: "w", requestId: "r" });
    expect(retryDisposition(err)).toBe("paid-or-in-doubt");
    expect(isTransientError(err)).toBe(false);
  });
});

describe.each([
  ["LLMClient (Base)", evmClient, evm402],
  ["SolanaLLMClient (exact)", solanaClient, solana402],
] as const)("%s fallback after a failure", (_name, make, challenge) => {
  // The EVM client retries a 502/503 once on its own, with the same payload.
  const unpaid503: Answer[] = make === evmClient ? [status(503), status(503)] : [status(503)];
  const paid503: Answer[] = make === evmClient ? [status(503), status(503)] : [status(503)];

  describe("before any payment was sent: moves on to the next model", () => {
    it.each([
      ["429", [status(429)]],
      ["503", unpaid503],
      ["timeout", [timeout]],
    ])("%s", async (_label, failure) => {
      const client = make();
      answers.push(...failure, ok());

      const response = await chat(client);

      expect(response.model).toBe(FALLBACK);
      expect(calls.filter((c) => c.paid)).toHaveLength(0);
      expect(calls.at(-1)).toMatchObject({ model: FALLBACK, paid: false });
    });
  });

  describe("after the payment was sent: raises, and buys no other model", () => {
    it.each([
      ["429", [status(429)]],
      ["503", paid503],
      ["timeout", [timeout]],
    ])("%s", async (_label, failure) => {
      const client = make();
      answers.push(challenge, ...failure, ok());

      const raised = await chat(client).catch((err: unknown) => err);

      expect(retryDisposition(raised)).toBe("paid-or-in-doubt");
      expect(isTransientError(raised)).toBe(false);
      // Only the primary model was ever requested; the fallback's answer is still queued.
      expect(calls.map((c) => c.model)).toEqual(Array(calls.length).fill(PRIMARY));
      expect(answers).toHaveLength(1);
      // Any re-send carried the very same signed payment, never a new one.
      expect(new Set(calls.filter((c) => c.paid).map((c) => c.signature)).size).toBe(1);
    });
  });

  it("does not move on when the paid response's body cannot be read", async () => {
    const client = make();
    answers.push(challenge, () => new Response("not json", { status: 200 }), ok());

    const raised = await chat(client).catch((err: unknown) => err);

    expect(retryDisposition(raised)).toBe("paid-or-in-doubt");
    expect(answers).toHaveLength(1);
  });
});

describe("SolanaLLMClient (exact): 503 PAYMENT_VERIFICATION_UNAVAILABLE after the payment", () => {
  // sol.blockrun.ai sends this code only when verification itself could not run:
  // nothing settled, nothing broadcast. Same rule as the batch path's refusal list.
  const pvu: Answer = () => Response.json(
    { error: "Payment verification temporarily unavailable", message: "Retry the request; the signed payment was not rejected.", code: "PAYMENT_VERIFICATION_UNAVAILABLE", reason: "verification_unavailable" },
    { status: 503, headers: { "Retry-After": "7" } },
  );

  it("is unpaid: moves on to the fallback model, which pays once with its own payment", async () => {
    const client = solanaClient();
    answers.push(solana402, pvu, solana402, ok());

    const response = await chat(client);

    expect(response.model).toBe(FALLBACK);
    expect(calls.map((c) => [c.model, c.paid])).toEqual([[PRIMARY, false], [PRIMARY, true], [FALLBACK, false], [FALLBACK, true]]);
  });

  it("control: a 503 with any other body after the payment stays in doubt", async () => {
    const client = solanaClient();
    answers.push(solana402, () => Response.json({ error: "Service Unavailable", code: "MODEL_UNAVAILABLE" }, { status: 503 }), ok());

    const raised = await chat(client).catch((err: unknown) => err);

    expect(retryDisposition(raised)).toBe("paid-or-in-doubt");
    expect(answers).toHaveLength(1);
  });

  it("control: the code on a non-503 status proves nothing", async () => {
    const client = solanaClient();
    answers.push(solana402, () => Response.json({ code: "PAYMENT_VERIFICATION_UNAVAILABLE" }, { status: 502 }), ok());

    const raised = await chat(client).catch((err: unknown) => err);

    expect(retryDisposition(raised)).toBe("paid-or-in-doubt");
  });
});

describe("account mode (API key): the request itself is billed", () => {
  const KEY = "brk_test_disposition";

  it("moves on after the account API's explicit 429", async () => {
    const client = evmClient({ apiKey: KEY });
    answers.push(status(429), ok());

    await expect(chat(client)).resolves.toMatchObject({ model: FALLBACK });
  });

  // api.blockrun.ai debits only an accepted 2xx; its own 5xx (a JSON error
  // envelope) released the credit hold, so the fallback may be tried.
  it.each([
    ["502 upstream unavailable", 502, { error: { message: "Upstream provider unavailable. Please retry.", type: "api_error", code: "upstream_unavailable" } }],
    ["502 invalid upstream response", 502, { error: { message: "Provider returned an invalid API response. Please retry.", type: "api_error", code: "invalid_upstream_response" } }],
    ["503 with a top-level message", 503, { message: "Service temporarily unavailable", code: "MODEL_UNAVAILABLE" }],
  ])("moves on after the account API's own %s (nothing was debited)", async (_label, code, body) => {
    const client = evmClient({ apiKey: KEY });
    answers.push(() => Response.json(body, { status: code }), ok());

    await expect(chat(client)).resolves.toMatchObject({ model: FALLBACK });
    expect(calls.map((c) => c.model)).toEqual([PRIMARY, FALLBACK]);
  });

  it.each([
    ["HTML 502 from a load balancer", () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } })],
    ["plain-text 504 upstream timeout", () => new Response("upstream request timeout", { status: 504 })],
    ["502 with an empty message", () => Response.json({ error: { message: "" } }, { status: 502 })],
  ])("does not move on after an %s, which proves nothing about the debit", async (_label, failure) => {
    const client = evmClient({ apiKey: KEY });
    answers.push(failure as Answer, ok());

    const raised = await chat(client).catch((err: unknown) => err);

    expect(retryDisposition(raised)).toBe("paid-or-in-doubt");
    expect(calls.map((c) => c.model)).toEqual([PRIMARY]);
  });

  it.each([
    ["503", status(503)],
    ["timeout", timeout],
  ])("does not move on after a %s, which may follow a billed request", async (_label, failure) => {
    const client = evmClient({ apiKey: KEY });
    answers.push(failure, ok());

    const raised = await chat(client).catch((err: unknown) => err);

    expect(retryDisposition(raised)).toBe("paid-or-in-doubt");
    expect(calls.map((c) => c.model)).toEqual([PRIMARY]);
  });
});
