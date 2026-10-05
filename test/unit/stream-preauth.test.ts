// A streamed chat call reuses the last 402's terms ("pre-auth") and sends a
// signed payment on its first request. The gateway settles a stream when it
// starts, so once that payment is sent, only a 402 (refused at verification:
// nothing settled) may fall back to the normal 402 → sign → send flow. Any
// other failure must raise in doubt, never sign and send a second payment.
// Only `fetch` is faked; signing is the real EVM signer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/client";
import { APIError, retryDisposition } from "../../src/types";
import { TEST_PRIVATE_KEY, buildPaymentRequiredResponse } from "../helpers/testHelpers";

type Answer = () => Response | Promise<Response>;

const sse: Answer = () => new Response("data: {}\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
const evm402: Answer = () => new Response("{}", { status: 402, headers: { "payment-required": buildPaymentRequiredResponse() } });
const status = (code: number): Answer => () => Response.json({ error: `status ${code}` }, { status: code });
const timeout: Answer = () => {
  throw new DOMException("The operation was aborted.", "AbortError");
};

let answers: Answer[];
let signatures: Array<string | undefined>;

beforeEach(() => {
  answers = [];
  signatures = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    signatures.push(new Headers(init?.headers).get("PAYMENT-SIGNATURE") ?? undefined);
    const next = answers.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const stream = (client: LLMClient) => client.chatCompletionStream("openai/gpt-4o-mini", [{ role: "user", content: "gm" }]);

/** A client whose pre-auth cache holds the terms of one paid stream. */
async function warmed(): Promise<LLMClient> {
  const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
  answers.push(evm402, sse);
  await stream(client);
  expect(signatures).toEqual([undefined, expect.any(String)]);
  signatures = [];
  return client;
}

describe("chatCompletionStream pre-auth never pays twice", () => {
  it("control: a pre-auth hit sends ONE signed request and no 402 round-trip", async () => {
    const client = await warmed();
    answers.push(sse);
    const res = await stream(client);
    expect(res.status).toBe(200);
    expect(signatures).toEqual([expect.any(String)]);
    expect(client.getSpending().calls).toBe(2);
  });

  it("a 402 to the pre-auth payment (refused at verification) falls back and pays once", async () => {
    const client = await warmed();
    answers.push(evm402, evm402, sse);
    const res = await stream(client);
    expect(res.status).toBe(200);
    // pre-auth signed (refused) → unpaid probe → fresh 402 → one new signed payment
    expect(signatures).toEqual([expect.any(String), undefined, expect.any(String)]);
    expect(signatures[0]).not.toBe(signatures[2]);
  });

  it.each([
    ["a 5xx", status(502)],
    ["a 504", status(504)],
    ["a 500", status(500)],
  ])("%s after the pre-auth payment raises in doubt and never sends a second payment", async (_label, answer) => {
    const client = await warmed();
    answers.push(answer);
    const err = await stream(client).catch(e => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toMatch(/after payment/);
    expect(retryDisposition(err)).toBe("paid-or-in-doubt");
    expect(signatures).toEqual([expect.any(String)]);
  });

  it("a timeout after the pre-auth payment raises in doubt and never sends a second payment", async () => {
    const client = await warmed();
    answers.push(timeout);
    const err = await stream(client).catch(e => e);
    expect(retryDisposition(err)).toBe("paid-or-in-doubt");
    expect(signatures).toEqual([expect.any(String)]);
  });

  it("the failed pre-auth evicts the cached terms: the next call starts with an unpaid probe", async () => {
    const client = await warmed();
    answers.push(status(502));
    await stream(client).catch(() => undefined);
    signatures = [];
    answers.push(evm402, sse);
    await stream(client);
    expect(signatures).toEqual([undefined, expect.any(String)]);
  });
});
