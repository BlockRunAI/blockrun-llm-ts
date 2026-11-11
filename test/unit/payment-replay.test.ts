// `PAYMENT_REPLAY`: the gateway refused a payment as already used.
//
// Ticket SDK2 (blockrun specs/2026-11-06-paid-path-alignment.md). The gateway
// sends `code: "PAYMENT_REPLAY"` when the signed authorization was submitted
// before. The earlier request may already have been served and charged, so
// every paid call must:
//   - throw PaymentReplayError (not a "check your wallet balance"
//     PaymentError), carrying the gateway's message / details and any
//     poll_url / job_id / wallet_auth verbatim;
//   - sign nothing new. A fresh authorization for the same request can be a
//     second charge.
//
// The bodies below are the gateway's literal shapes from blockrun
// src/lib/payment-nonce.ts (replayResponse, recoverClaimedJob) and
// src/app/api/v1/chat/completions/route.ts. Only `fetch` is faked; signing is
// the real EVM signer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicClient,
  ImageClient,
  LLMClient,
  MusicClient,
  PAYMENT_REPLAY,
  PaymentError,
  PaymentReplayError,
  SearchClient,
  VideoClient,
  isPaymentReplay,
  paymentRejectedErrorFromBody,
} from "../../src/index";
import { TEST_ACCOUNT, TEST_PRIVATE_KEY, buildPaymentRequiredResponse } from "../helpers/testHelpers";

const ALREADY_USED = {
  error: "Payment authorization already used",
  message:
    "This authorization was already submitted and may already have been charged. " +
    "Check the transaction on chain before signing a new one.",
  code: "PAYMENT_REPLAY",
  payer: TEST_ACCOUNT.address,
};

const WALLET_AUTH = {
  timestamp: "1762800000",
  message: "blockrun.ai wants you to prove ownership of the wallet that paid job ...",
  headers: ["X-Wallet-Address", "X-Wallet-Timestamp", "X-Wallet-Signature"],
  expires_in: 300,
};
const ALREADY_SETTLED = {
  error: "Payment authorization already settled",
  code: "PAYMENT_REPLAY",
  message:
    "This authorization has settled and belongs to an earlier request. To get its " +
    "poll_url, sign wallet_auth.message with the paying wallet (EIP-191) and resend " +
    "this request with the headers in wallet_auth. A new authorization starts a " +
    "separate billable request.",
  wallet_auth: WALLET_AUTH,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const job202 = (kind: string) => () =>
  json(202, { id: "job_1", status: "queued", poll_url: `/api/v1/${kind}/generations/job_1` });

type Answer = () => Response;

/** 402 on every unpaid request; scripted answers for each paid one. */
class Gateway {
  signatures: string[] = [];
  challenges = 0;
  constructor(private paid: Answer[]) {}
  fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const signature = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
    if (!signature) {
      this.challenges++;
      return new Response(JSON.stringify({ error: "Payment Required" }), {
        status: 402,
        headers: { "content-type": "application/json", "payment-required": buildPaymentRequiredResponse() },
      });
    }
    this.signatures.push(signature);
    const next = this.paid.shift();
    if (!next) throw new Error("unexpected paid request");
    return next();
  });
}

/** One challenge, one signature. Re-sending the SAME header is allowed (it
 * settles at most once); a second, different signature is not. */
function expectOneAuthorization(gw: Gateway) {
  expect(gw.challenges).toBe(1);
  expect(new Set(gw.signatures).size).toBe(1);
}

function expectReplay(err: unknown, body: { message: string }) {
  expect(err).toBeInstanceOf(PaymentReplayError);
  expect(err).toBeInstanceOf(PaymentError);
  const e = err as PaymentReplayError;
  expect(e.code).toBe(PAYMENT_REPLAY);
  expect(e.statusCode).toBe(402);
  expect(e.serverMessage).toBe(body.message);
  expect(e.message).toContain(body.message);
  expect(e.message.toLowerCase()).not.toContain("wallet balance");
  expect(e.response?.code).toBe("PAYMENT_REPLAY");
  expect(e.response?.message).toBe(body.message);
}

async function run(gw: Gateway, call: () => Promise<unknown>) {
  vi.stubGlobal("fetch", gw.fetch);
  const settled = call().then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await vi.advanceTimersByTimeAsync(1_000_000);
  return settled;
}

const calls: Record<string, () => Promise<unknown>> = {
  chat: () => new LLMClient({ privateKey: TEST_PRIVATE_KEY }).chatCompletion("openai/gpt-5.4", [{ role: "user", content: "hi" }]),
  search: () => new SearchClient({ privateKey: TEST_PRIVATE_KEY }).search("x402"),
  image: () => new ImageClient({ privateKey: TEST_PRIVATE_KEY }).generate("a cat"),
  music: () => new MusicClient({ privateKey: TEST_PRIVATE_KEY }).generate("lo-fi"),
  video: () => new VideoClient({ privateKey: TEST_PRIVATE_KEY }).generate("a wave"),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("BLOCKRUN_API_KEY", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("PAYMENT_REPLAY on the paid request: PaymentReplayError, nothing signed again", () => {
  for (const [name, call] of Object.entries(calls)) {
    for (const [label, body] of [["used", ALREADY_USED], ["settled", ALREADY_SETTLED]] as const) {
      it(`${name} (${label})`, async () => {
        const gw = new Gateway([() => json(402, body)]);
        const { error } = await run(gw, call);
        expectReplay(error, body);
        expectOneAuthorization(gw);
      });
    }

    it(`${name}: the wallet_auth challenge is carried verbatim`, async () => {
      const gw = new Gateway([() => json(402, ALREADY_SETTLED)]);
      const { error } = await run(gw, call);
      expect((error as PaymentReplayError).walletAuth).toEqual(WALLET_AUTH);
      expect((error as PaymentReplayError).response?.wallet_auth).toEqual(WALLET_AUTH);
    });
  }

  it("chat: a replay after a same-header 502 retry is not paid again", async () => {
    const gw = new Gateway([() => json(502, { error: "Bad gateway" }), () => json(402, ALREADY_USED)]);
    const { error } = await run(gw, calls.chat);
    expectReplay(error, ALREADY_USED);
    expect((error as PaymentReplayError).payer).toBe(TEST_ACCOUNT.address);
    expect(gw.signatures).toHaveLength(2); // the same header, sent twice
    expectOneAuthorization(gw);
  });

  it("anthropic-compatible client: PaymentReplayError, one signature", async () => {
    const gw = new Gateway([() => json(402, ALREADY_USED)]);
    const { error } = await run(gw, () =>
      new AnthropicClient({ privateKey: TEST_PRIVATE_KEY }).messages.create({
        model: "anthropic/claude-sonnet-4.6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      })
    );
    // The Anthropic SDK wraps a throwing fetch as a connection error; the
    // replay is its cause. maxRetries is 0 in wallet mode, so it is not re-run.
    expectReplay((error as { cause?: unknown }).cause, ALREADY_USED);
    expectOneAuthorization(gw);
  });
});

describe("PAYMENT_REPLAY on a poll", () => {
  it.each([
    ["image", "images"],
    ["music", "audio"],
  ])("%s: a poll replay throws PaymentReplayError without signing again", async (name, kind) => {
    const gw = new Gateway([job202(kind), () => json(402, ALREADY_USED)]);
    const { error } = await run(gw, calls[name]);
    expectReplay(error, ALREADY_USED);
    expectOneAuthorization(gw);
  });

  it("video: a mid-poll replay is not treated as signature expiry and re-signed", async () => {
    const gw = new Gateway([job202("videos"), () => json(402, ALREADY_USED)]);
    const { error } = await run(gw, calls.video);
    expectReplay(error, ALREADY_USED);
    expectOneAuthorization(gw);
  });

  it("video (control): a non-replay mid-poll 402 keeps the documented re-sign", async () => {
    const done = () =>
      json(200, { id: "job_1", status: "completed", created: 1, model: "xai/grok-imagine-video", data: [{ url: "https://x/v.mp4" }] });
    const gw = new Gateway([job202("videos"), () => json(402, { error: "Payment verification failed" }), done]);
    const { error } = await run(gw, calls.video);
    expect(error).toBeUndefined();
    expect(gw.challenges).toBe(2);
    expect(new Set(gw.signatures).size).toBe(2);
  });

  it("video: a refusal after the re-signs carries the gateway's reason", async () => {
    const refused = () => json(402, { error: "Payment verification failed", details: "insufficient_funds" });
    const gw = new Gateway([job202("videos"), refused, refused, refused]);
    const { error } = await run(gw, calls.video);
    expect(error).toBeInstanceOf(PaymentError);
    expect(error).not.toBeInstanceOf(PaymentReplayError);
    expect((error as Error).message).toContain("insufficient_funds");
  });
});

describe("paymentRejectedErrorFromBody", () => {
  it("keeps poll_url / job_id / recoverable from a replay naming the earlier job", () => {
    const err = paymentRejectedErrorFromBody({
      status: "in_progress",
      object: "generation.job",
      message: "An earlier request owns this authorization and may still be running.",
      code: "PAYMENT_REPLAY",
      payer: TEST_ACCOUNT.address,
      id: "job_9",
      job_id: "job_9",
      poll_url: "/api/v1/videos/generations/job_9",
      recoverable: true,
    }) as PaymentReplayError;
    expect(err).toBeInstanceOf(PaymentReplayError);
    expect(err.pollUrl).toBe("/api/v1/videos/generations/job_9");
    expect(err.jobId).toBe("job_9");
    expect(err.recoverable).toBe(true);
    expect(err.message).toContain("/api/v1/videos/generations/job_9");
  });

  it("keeps details", () => {
    const err = paymentRejectedErrorFromBody({ ...ALREADY_USED, details: "nonce_already_used" }) as PaymentReplayError;
    expect(err.details).toBe("nonce_already_used");
    expect(err.message).toContain("nonce_already_used");
  });

  it("reads flat and nested codes", () => {
    expect(isPaymentReplay(ALREADY_USED)).toBe(true);
    expect(isPaymentReplay({ error: { code: "payment_replay" } })).toBe(true);
    expect(isPaymentReplay({ error: "Payment verification failed" })).toBe(false);
    expect(isPaymentReplay(null)).toBe(false);
  });

  it("a non-replay 402 passes the gateway's reason through (PAYMENT_MALFORMED)", async () => {
    const body = {
      error: "Malformed payment",
      message: "accepted.amount does not match the quoted price",
      code: "PAYMENT_MALFORMED",
    };
    const gw = new Gateway([() => json(402, body)]);
    const { error } = await run(gw, calls.search);
    expect(error).toBeInstanceOf(PaymentError);
    expect(error).not.toBeInstanceOf(PaymentReplayError);
    const e = error as PaymentError;
    expect(e.message).toContain("Malformed payment");
    expect(e.message).toContain("accepted.amount does not match the quoted price");
    expect(e.message.toLowerCase()).not.toContain("wallet balance");
    expect(e.response?.code).toBe("PAYMENT_MALFORMED");
  });
});

describe("SolanaLLMClient: a paid 402", () => {
  const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";
  const assertPaid = async (body: unknown) => {
    const { SolanaLLMClient } = await import("../../src/solana-client");
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    return (client as unknown as { assertPaid(r: Response): Promise<void> }).assertPaid(json(402, body));
  };

  it("PAYMENT_REPLAY throws PaymentReplayError (terminal, not a stale-blockhash re-sign)", async () => {
    const solReplay = {
      error: "Payment authorization already used",
      message: "This payment signature was already redeemed. Sign a new payment for each request.",
      code: "PAYMENT_REPLAY",
    };
    const error = await assertPaid(solReplay).catch((e: unknown) => e);
    expectReplay(error, solReplay);
  });

  it("other refusals carry the gateway's reason", async () => {
    const error = await assertPaid({ error: "Payment settlement failed", code: "SETTLEMENT_FAILED", reason: "expired_signature" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentError);
    expect(error).not.toBeInstanceOf(PaymentReplayError);
    expect((error as Error).message).toContain("Payment settlement failed");
    expect((error as Error).message.toLowerCase()).not.toContain("balance");
  });
});
