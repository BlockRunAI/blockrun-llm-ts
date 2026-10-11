// Solana async media polls prove job ownership with an ed25519 signature
// (x-poll-*) instead of signing a payment on every poll. These tests pin:
// the exact signed bytes; that pending polls never touch the payment signer;
// that a finished video is paid exactly once; that music/image polls never pay;
// the one-shot fallback to x-payment polling; and that Base polling is unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "crypto";
import bs58 from "bs58";
import { TEST_PRIVATE_KEY, buildPaymentRequiredResponse } from "../helpers/testHelpers";

// A real ed25519 wallet, so the proofs can be verified the way the gateway does.
const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ed25519");
const PUB = Buffer.from((pub.export({ format: "jwk" }) as { x: string }).x, "base64url");
const SEED = Buffer.from((priv.export({ format: "jwk" }) as { d: string }).d, "base64url");
const SECRET = new Uint8Array(Buffer.concat([SEED, PUB]));
const SOL_KEY = bs58.encode(SECRET);
const WALLET = bs58.encode(PUB);

vi.mock("../../src/solana-wallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/solana-wallet.js")>();
  // the real solanaKeyToBytes decodes SOL_KEY; only the web3.js-backed address lookup is stubbed
  return { ...actual, solanaPublicKey: vi.fn(async () => WALLET) };
});

const signed: string[] = [];
vi.mock("../../src/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/x402.js")>();
  return {
    ...actual,
    createSolanaPaymentPayload: vi.fn(async () => {
      const tx = `signed-tx-${signed.length}`;
      signed.push(tx);
      return tx;
    }),
  };
});

const { signPollOwnership, pollAuthMessage, pollJobIdFromUrl } = await import("../../src/poll-ownership.js");
const { SolanaLLMClient } = await import("../../src/solana-client.js");
const { retryDisposition } = await import("../../src/types.js");

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const CHALLENGE = {
  x402Version: 2,
  accepts: [{
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: "40000",
    payTo: WALLET,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    maxTimeoutSeconds: 300,
    resource: { url: "https://sol.blockrun.ai/api/v1/videos/generations" },
    extra: { feePayer: WALLET },
  }],
};

const API = "https://sol.blockrun.ai/api";

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Call = { method: string; url: string; headers: Record<string, string> };
function header(call: Call, name: string): string | undefined {
  const key = Object.keys(call.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? call.headers[key] : undefined;
}
const hasProof = (c: Call) => header(c, "x-poll-signature") !== undefined;
const hasPayment = (c: Call) => header(c, "PAYMENT-SIGNATURE") !== undefined;

/** Verify a request's x-poll-* proof exactly as sol's readPollOwnership does. */
function proofVerifies(call: Call, kind: string, jobId: string): boolean {
  const wallet = Buffer.from(bs58.decode(header(call, "x-poll-wallet")!));
  const sig = Buffer.from(bs58.decode(header(call, "x-poll-signature")!));
  const ts = Number(header(call, "x-poll-timestamp"));
  if (wallet.length !== 32 || sig.length !== 64) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: wallet.toString("base64url") }, format: "jwk" });
  return verify(null, Buffer.from(`blockrun-poll:v1:${kind}:${jobId}:${ts}`, "utf8"), key, sig);
}

function stubFetch(handler: (call: Call, calls: Call[]) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(url),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    };
    calls.push(call);
    return handler(call, calls);
  }));
  return calls;
}

type Follow = (
  submit: Record<string, unknown>, budgetMs: number, kind: "video" | "audio" | "image", intervalMs?: number
) => Promise<Record<string, unknown>>;
function follow(client: InstanceType<typeof SolanaLLMClient>): Follow {
  const c = client as unknown as { followSolanaJob: Follow };
  return c.followSolanaJob.bind(client);
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  signed.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  warn.mockRestore();
});

describe("poll-ownership proof", () => {
  it("signs exactly blockrun-poll:v1:<kind>:<jobId>:<ts> with the wallet's key, base58 headers", () => {
    const now = 1_760_000_000_123;
    const headers = signPollOwnership(SECRET, "video", "job-abc", now);
    const ts = Math.floor(now / 1000);

    expect(headers["x-poll-timestamp"]).toBe(String(ts));
    expect(headers["x-poll-wallet"]).toBe(WALLET);
    expect(bs58.decode(headers["x-poll-wallet"]).length).toBe(32);
    const sig = Buffer.from(bs58.decode(headers["x-poll-signature"]));
    expect(sig.length).toBe(64);

    const message = pollAuthMessage("video", "job-abc", ts);
    expect(message).toBe(`blockrun-poll:v1:video:job-abc:${ts}`);
    expect(verify(null, Buffer.from(message, "utf8"), pub, sig)).toBe(true);
    // control: the same signature does not verify for another kind, job or time
    expect(verify(null, Buffer.from(`blockrun-poll:v1:image:job-abc:${ts}`), pub, sig)).toBe(false);
    expect(verify(null, Buffer.from(`blockrun-poll:v1:video:job-abd:${ts}`), pub, sig)).toBe(false);
    expect(verify(null, Buffer.from(`blockrun-poll:v1:video:job-abc:${ts + 1}`), pub, sig)).toBe(false);
  });

  it("derives the same wallet from a 32-byte seed", () => {
    expect(signPollOwnership(SEED, "audio", "j", 0)["x-poll-wallet"]).toBe(WALLET);
  });

  it("takes the job id from the poll_url path, decoded, without the query", () => {
    expect(pollJobIdFromUrl("/api/v1/videos/generations/v1.ab%2Bc%3D?model=m&duration=5&sig=s")).toBe("v1.ab+c=");
    expect(pollJobIdFromUrl("https://sol.blockrun.ai/api/v1/audio/generations/aud_123")).toBe("aud_123");
  });
});

describe("Solana video: polls prove ownership, the finished video is paid once", () => {
  it("submits, polls with x-poll-* (never paying), pays the completion 402 once, delivers", async () => {
    vi.useFakeTimers();
    const pollPath = "/api/v1/videos/generations/vid%2B1?model=xai%2Fgrok-imagine-video&duration=5&sig=s";
    const calls = stubFetch((call, all) => {
      if (call.method === "POST") {
        return hasPayment(call)
          ? res(202, { id: "vid+1", status: "queued", poll_url: pollPath, payment_status: "verified" })
          : res(402, CHALLENGE);
      }
      if (hasPayment(call)) {
        return res(200, {
          id: "vid+1", status: "completed", data: [{ url: "https://x/v.mp4" }],
          payment: { status: "settled", tx_hash: "TX" },
        }, { "x-payment-receipt": "TX" });
      }
      const proofPolls = all.filter((c) => c.method === "GET" && hasProof(c)).length;
      return proofPolls <= 2
        ? res(202, { id: "vid+1", status: "in_progress", payment_status: "not_charged" })
        : res(402, { ...CHALLENGE, error: "Payment Required", status: "completed", id: "vid+1" });
    });

    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    const pending = client.video("a red apple", { duration_seconds: 5 });
    await vi.runAllTimersAsync();
    const out = await pending;

    expect(out.data[0].url).toBe("https://x/v.mp4");
    expect(out.txHash).toBe("TX");

    const gets = calls.filter((c) => c.method === "GET");
    // the poll_url's /api is not doubled onto apiUrl's
    for (const g of gets) expect(g.url).toBe(`${API}/v1/videos/generations/vid%2B1?model=xai%2Fgrok-imagine-video&duration=5&sig=s`);
    const proofPolls = gets.filter(hasProof);
    expect(proofPolls).toHaveLength(3);
    for (const p of proofPolls) {
      expect(hasPayment(p)).toBe(false);
      expect(proofVerifies(p, "video", "vid+1")).toBe(true);
    }
    // ONE signature for the submit, ONE for the finished video — none for pending polls
    expect(signed).toHaveLength(2);
    expect(gets.filter(hasPayment)).toHaveLength(1);
    // the video is booked once, on delivery (the POST was only verified)
    expect(client.getSpending().calls).toBe(1);
  });

  it("pending polls never invoke the payment signer", async () => {
    let n = 0;
    const calls = stubFetch(() => (++n < 5
      ? res(202, { status: "queued", payment_status: "not_charged" })
      : res(200, { status: "failed", error: "upstream boom", payment_status: "not_charged" })));
    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    await expect(
      follow(client)({ id: "v", poll_url: "/api/v1/videos/generations/v?model=m&duration=5" }, 10_000, "video", 1)
    ).rejects.toThrow(/Upstream job failed: upstream boom/);
    expect(signed).toHaveLength(0);
    expect(calls.every((c) => hasProof(c) && !hasPayment(c))).toBe(true);
    expect(client.getSpending().calls).toBe(0);
  });

  it("re-polls a settlement-in-progress 402 without paying again, then delivers already_settled", async () => {
    let paidOnce = false;
    const calls = stubFetch((call) => {
      if (hasPayment(call)) {
        paidOnce = true;
        return res(402, { error: "Payment settlement in progress" }, { "retry-after": "0" });
      }
      return paidOnce
        ? res(200, { status: "completed", data: [{ url: "u" }], payment: { status: "already_settled" } })
        : res(402, { ...CHALLENGE, status: "completed" });
    });
    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    const out = await follow(client)({ id: "v", poll_url: "/api/v1/videos/generations/v" }, 10_000, "video", 1);
    expect(out.status).toBe("completed");
    expect(signed).toHaveLength(1);
    expect(calls.filter(hasPayment)).toHaveLength(1);
    expect(client.getSpending().calls).toBe(1);
  });

  it("a paid poll lost in transit is not abandoned: the next proof poll delivers it, one payment", async () => {
    let paidSent = false;
    const calls = stubFetch((call) => {
      if (hasPayment(call)) { paidSent = true; throw new TypeError("fetch failed"); }
      return paidSent
        ? res(200, { status: "completed", data: [{ url: "u" }], payment: { status: "already_settled" } })
        : res(402, { ...CHALLENGE, status: "completed" });
    });
    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    const out = await follow(client)({ id: "v", poll_url: "/api/v1/videos/generations/v" }, 10_000, "video", 1);
    expect(out.status).toBe("completed");
    expect(signed).toHaveLength(1);
    expect(calls.filter(hasPayment)).toHaveLength(1);
    expect(client.getSpending().calls).toBe(1);
  });

  it("a paid media POST lost in transit is raised paid-or-in-doubt", async () => {
    stubFetch((call) => {
      if (hasPayment(call)) throw new TypeError("fetch failed");
      return res(402, CHALLENGE);
    });
    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    const err = await client.music("lofi").catch((e: unknown) => e);
    expect(retryDisposition(err)).toBe("paid-or-in-doubt");
  });

  it("a payment refused at verification is raised, not re-signed", async () => {
    stubFetch((call) => hasPayment(call)
      ? res(402, { error: "Payment verification failed", reason: "insufficient_funds" })
      : res(402, { ...CHALLENGE, status: "completed" }));
    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    await expect(
      follow(client)({ id: "v", poll_url: "/api/v1/videos/generations/v" }, 10_000, "video", 1)
    ).rejects.toThrow(/rejected/);
    expect(signed).toHaveLength(1);
    expect(client.getSpending().calls).toBe(0);
  });
});

describe("Solana music and image polls never pay", () => {
  for (const [kind, path] of [["audio", "/api/v1/audio/generations/aud_1"], ["image", "/api/v1/images/generations/img_1"]] as const) {
    it(`${kind}: x-poll-* until completed, no payment signed`, async () => {
      let n = 0;
      const calls = stubFetch(() => (++n < 3
        ? res(202, { status: "in_progress", payment_status: "settled_optimistic" })
        : res(200, { status: "completed", data: [{ url: "https://x/out" }], payment: { status: "settled_at_post" } })));
      const client = new SolanaLLMClient({ privateKey: SOL_KEY });
      const out = await follow(client)({ id: path.split("/").pop(), poll_url: path }, 10_000, kind, 1);
      expect(out.status).toBe("completed");
      expect(signed).toHaveLength(0);
      expect(calls).toHaveLength(3);
      for (const c of calls) {
        expect(hasPayment(c)).toBe(false);
        expect(proofVerifies(c, kind, path.split("/").pop()!)).toBe(true);
      }
    });
  }

  it("music(): pays the POST once, books it at POST, polls with proofs only", async () => {
    vi.useFakeTimers();
    const calls = stubFetch((call, all) => {
      if (call.method === "POST") {
        return hasPayment(call)
          ? res(202, { id: "aud_9", status: "queued", poll_url: "/api/v1/audio/generations/aud_9" })
          : res(402, CHALLENGE);
      }
      return all.filter((c) => c.method === "GET").length < 2
        ? res(202, { status: "in_progress" })
        : res(200, { status: "completed", data: [{ url: "https://x/t.mp3" }] });
    });
    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    const pending = client.music("lofi");
    await vi.runAllTimersAsync();
    const out = await pending;
    expect(out.data[0].url).toBe("https://x/t.mp3");
    expect(signed).toHaveLength(1);
    const gets = calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(2);
    for (const g of gets) {
      expect(hasPayment(g)).toBe(false);
      expect(proofVerifies(g, "audio", "aud_9")).toBe(true);
    }
    expect(client.getSpending().calls).toBe(1);
  });
});

describe("fallback to x-payment polling, once per job", () => {
  it("video: a 400 'Invalid job id' on the proof poll falls back and is logged", async () => {
    let paidPolls = 0;
    const calls = stubFetch((call) => {
      if (hasProof(call)) return res(400, { error: "Invalid job id" });
      if (!hasPayment(call)) return res(402, CHALLENGE);
      return ++paidPolls < 2
        ? res(202, { status: "in_progress", payment_status: "verified" })
        : res(200, { status: "completed", data: [{ url: "u" }], payment: { status: "settled" } });
    });
    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    const out = await follow(client)({ id: "v", poll_url: "/api/v1/videos/generations/v" }, 10_000, "video", 1);
    expect(out.status).toBe("completed");
    expect(calls.filter(hasProof)).toHaveLength(1);   // never retried
    expect(signed).toHaveLength(2);                   // the old path signs every poll
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/video job v: .*HTTP 400.*falling back to x-payment polling/);
    expect(client.getSpending().calls).toBe(1);
  });

  it("music: a 404 on the proof poll falls back once; a 404 on the old path is raised", async () => {
    const calls = stubFetch((call) => (hasProof(call) ? res(404, { error: "Job not found" }) : res(404, { error: "Job not found" })));
    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    await expect(
      follow(client)({ id: "a", poll_url: "/api/v1/audio/generations/a" }, 10_000, "audio", 1)
    ).rejects.toThrow(/Poll failed: 404/);
    expect(calls.filter(hasProof)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(signed).toHaveLength(0);
  });

  it("image: a batch-billed job's 402 falls back to the payment path", async () => {
    const calls = stubFetch((call) => {
      if (hasProof(call)) return res(402, { error: "Batch payment required" });
      if (!hasPayment(call)) return res(402, CHALLENGE);
      return res(200, { status: "completed", data: [{ url: "u" }] });
    });
    const client = new SolanaLLMClient({ privateKey: SOL_KEY });
    const out = await follow(client)({ id: "i", poll_url: "/api/v1/images/generations/i" }, 10_000, "image", 1);
    expect(out.status).toBe("completed");
    expect(calls.filter(hasProof)).toHaveLength(1);
    expect(signed).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("Base rail is unchanged", () => {
  it("VideoClient polls with its one PAYMENT-SIGNATURE and never sends x-poll-*", async () => {
    vi.useFakeTimers();
    const { VideoClient } = await import("../../src/video.js");
    const challenge = buildPaymentRequiredResponse({
      resource: { url: "https://blockrun.ai/api/v1/videos/generations", description: "video" },
    });
    let polls = 0;
    const calls = stubFetch((call) => {
      if (call.method === "POST") {
        return hasPayment(call)
          ? res(202, { id: "b1", status: "queued", poll_url: "/api/v1/videos/generations/b1" })
          : res(402, {}, { "payment-required": challenge });
      }
      return ++polls < 2
        ? res(202, { status: "in_progress" })
        : res(200, { status: "completed", data: [{ url: "https://x/b.mp4" }] });
    });
    const client = new VideoClient({ privateKey: TEST_PRIVATE_KEY });
    const pending = client.generate("x");
    await vi.runAllTimersAsync();
    const out = await pending;
    expect(out.data[0].url).toBe("https://x/b.mp4");

    const gets = calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(2);
    const submitted = header(calls.find((c) => c.method === "POST" && hasPayment(c))!, "PAYMENT-SIGNATURE");
    for (const g of gets) {
      expect(hasProof(g)).toBe(false);
      expect(Object.keys(g.headers).some((k) => k.toLowerCase().startsWith("x-poll-"))).toBe(false);
      expect(header(g, "PAYMENT-SIGNATURE")).toBe(submitted);
    }
    expect(signed).toHaveLength(0); // no Solana signing on Base
  });
});
