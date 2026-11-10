import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

// A 402 for the Solana `exact` scheme can quote the blockhash the payment
// should be signed on, in `extra.recentBlockhash`. These tests pin that the
// SDK signs on that hash when it is a real blockhash, falls back to its own
// fetched hash otherwise, keeps the duplicate-transaction guard working on a
// quoted hash, and re-reads the quote of the NEW 402 on a stale-blockhash
// re-sign.
//
// The RPC is mocked with a hoisted mock (see x402-solana-cache.test.ts for why
// not vi.doMock): `rpc.hashes` is what the client's own getLatestBlockhash
// returns, in order, the last one repeating.
const rpc = vi.hoisted(() => ({
  hashes: [] as string[],
  blockhashCalls: 0,
}));

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  return {
    ...actual,
    Connection: class {
      async getLatestBlockhash() {
        const i = Math.min(rpc.blockhashCalls, rpc.hashes.length - 1);
        rpc.blockhashCalls++;
        return { blockhash: rpc.hashes[i] };
      }
    },
  };
});

const { createSolanaPaymentPayload, __resetSolanaPaymentCaches } = await import("../../src/x402");
const { SolanaLLMClient } = await import("../../src/solana-client");
const { bs58 } = await import("../../src/bs58");

const FEE_PAYER = Keypair.generate().publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const PAYER = Keypair.generate();

// A blockhash is a 32-byte base58 value; a pubkey has the same shape.
const newHash = () => Keypair.generate().publicKey.toBase58();
const FETCHED = newHash();
const QUOTED = newHash();

/** The recentBlockhash inside a base64 x402 payment payload's transaction. */
function signedBlockhash(payment: string): string {
  const tx = JSON.parse(atob(payment)).payload.transaction as string;
  return VersionedTransaction.deserialize(Buffer.from(tx, "base64")).message.recentBlockhash;
}

function transactionOf(payment: string): string {
  return JSON.parse(atob(payment)).payload.transaction as string;
}

async function pay(
  extra: Record<string, unknown> | undefined,
  options: { amount?: string; forceFreshBlockhash?: boolean } = {},
): Promise<string> {
  return createSolanaPaymentPayload(
    PAYER.secretKey,
    PAYER.publicKey.toBase58(),
    RECIPIENT,
    options.amount ?? "11500",
    FEE_PAYER,
    {
      ...(extra ? { extra } : {}),
      ...(options.forceFreshBlockhash ? { forceFreshBlockhash: true } : {}),
    },
  );
}

beforeEach(() => {
  rpc.hashes = [FETCHED];
  rpc.blockhashCalls = 0;
  __resetSolanaPaymentCaches();
});

describe("createSolanaPaymentPayload with a quoted blockhash", () => {
  it("signs the transaction on the 402's quoted blockhash, without asking the RPC", async () => {
    const payment = await pay({ feePayer: FEE_PAYER, recentBlockhash: QUOTED });
    expect(signedBlockhash(payment)).toBe(QUOTED);
    expect(rpc.blockhashCalls).toBe(0);
  });

  it("still echoes the quote back unchanged in accepted.extra", async () => {
    const extra = { feePayer: FEE_PAYER, recentBlockhash: QUOTED, other: "kept" };
    const payment = await pay(extra);
    expect(JSON.parse(atob(payment)).accepted.extra).toEqual(extra);
  });

  it("signs on its own fetched blockhash when the 402 quotes none", async () => {
    const payment = await pay({ feePayer: FEE_PAYER });
    expect(signedBlockhash(payment)).toBe(FETCHED);
    expect(rpc.blockhashCalls).toBe(1);
  });

  it("signs on its own fetched blockhash when there is no extra at all", async () => {
    const payment = await pay(undefined);
    expect(signedBlockhash(payment)).toBe(FETCHED);
    expect(rpc.blockhashCalls).toBe(1);
  });

  it("produces the same bytes with no quote as with a quote-less extra", async () => {
    // The no-quote path is unchanged: same blockhash, same fee step, same
    // deterministic ed25519 signature, so the transaction is byte-identical.
    const a = transactionOf(await pay({ feePayer: FEE_PAYER }));
    __resetSolanaPaymentCaches();
    rpc.blockhashCalls = 0;
    const b = transactionOf(await pay({ feePayer: FEE_PAYER, recentBlockhash: undefined }));
    expect(b).toBe(a);
  });

  it.each([
    ["an empty string", ""],
    ["a number", 12345],
    ["null", null],
    ["an object", { blockhash: QUOTED }],
    ["a non-base58 string", "0OIl+/not-a-blockhash"],
    ["a 16-byte base58 value", bs58.encode(new Uint8Array(16).fill(7))],
    ["a 64-byte base58 value", bs58.encode(new Uint8Array(64).fill(7))],
    ["a quoted hash with whitespace", ` ${QUOTED}`],
  ])("falls back to its own fetched blockhash when the quote is %s", async (_label, value) => {
    const payment = await pay({ feePayer: FEE_PAYER, recentBlockhash: value });
    expect(signedBlockhash(payment)).toBe(FETCHED);
    expect(rpc.blockhashCalls).toBe(1);
  });

  it("never emits the same transaction twice on one quoted blockhash", async () => {
    // Same quote, same economics: without the duplicate guard both would be
    // byte-identical and Solana would reject the second as already processed.
    const extra = { feePayer: FEE_PAYER, recentBlockhash: QUOTED };
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const payment = await pay(extra);
      expect(signedBlockhash(payment)).toBe(QUOTED);
      seen.add(transactionOf(payment));
    }
    expect(seen.size).toBe(5);
  });

  it("keeps a quoted and a fetched payment distinct when they share a blockhash", async () => {
    rpc.hashes = [QUOTED];
    const fetched = transactionOf(await pay({ feePayer: FEE_PAYER }));
    const quoted = transactionOf(await pay({ feePayer: FEE_PAYER, recentBlockhash: QUOTED }));
    expect(quoted).not.toBe(fetched);
  });

  it("does not put the quoted blockhash in the client's own cache", async () => {
    await pay({ feePayer: FEE_PAYER, recentBlockhash: QUOTED });
    const later = await pay({ feePayer: FEE_PAYER });
    expect(signedBlockhash(later)).toBe(FETCHED);
    expect(rpc.blockhashCalls).toBe(1);
  });

  it("does not let a quote displace a blockhash the client already cached", async () => {
    await pay({ feePayer: FEE_PAYER });
    await pay({ feePayer: FEE_PAYER, recentBlockhash: QUOTED });
    const later = await pay({ feePayer: FEE_PAYER }, { amount: "9700" });
    expect(signedBlockhash(later)).toBe(FETCHED);
    expect(rpc.blockhashCalls).toBe(1);
  });

  it("uses the quote even on a forced-fresh re-sign", async () => {
    const payment = await pay(
      { feePayer: FEE_PAYER, recentBlockhash: QUOTED },
      { forceFreshBlockhash: true },
    );
    expect(signedBlockhash(payment)).toBe(QUOTED);
    expect(rpc.blockhashCalls).toBe(0);
  });

  it("falls back to its own blockhash once the quoted hash's fee range is spent", async () => {
    const extra = { feePayer: FEE_PAYER, recentBlockhash: QUOTED };
    // MAX_FEE_NONCE_STEPS + 1 = 65 distinct transactions fit on one hash.
    for (let i = 0; i < 65; i++) expect(signedBlockhash(await pay(extra))).toBe(QUOTED);
    const overflow = await pay(extra);
    expect(signedBlockhash(overflow)).toBe(FETCHED);
    // 66 real ed25519 signatures: 2-8 s under a parallel full-suite run, past
    // vitest's 5 s default (it timed out on main at 8.2 s), so allow 30 s.
  }, 30_000);
});

// Every SolanaLLMClient path that signs an exact payment re-requests the
// resource after a verification-phase stale-blockhash rejection and signs on
// the NEW 402. These drive the real signer through each path and check that
// the retry carries the second 402's quote, not the first's.
describe("SolanaLLMClient stale-blockhash re-sign uses the new 402's quote", () => {
  const TEST_BS58_KEY = bs58.encode(PAYER.secretKey);

  function quote402(recentBlockhash: string): Response {
    return new Response(
      JSON.stringify({
        x402Version: 2,
        resource: { url: "https://sol.blockrun.ai/api/v1/chat/completions", description: "chat" },
        accepts: [
          {
            scheme: "exact",
            network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            amount: "1000",
            payTo: RECIPIENT,
            maxTimeoutSeconds: 300,
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            extra: { feePayer: FEE_PAYER, recentBlockhash },
          },
        ],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  }

  function staleRejection(): Response {
    return new Response(
      JSON.stringify({ code: "PAYMENT_BLOCKHASH_STALE", error: "Payment verification failed" }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  }

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  function sse(): Response {
    return new Response('data: {"ok":1}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;
  const signedHashes = () =>
    fetchSpy.mock.calls
      .map((call: Parameters<typeof fetch>) => (call[1]?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"])
      .filter((header): header is string => typeof header === "string")
      .map(signedBlockhash);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Run `call` while advancing the retry backoff timers. */
  async function run<T>(call: Promise<T>): Promise<T> {
    const settled = call.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1000);
    const result = (await settled) as { value?: T; error?: unknown };
    if ("error" in result) throw result.error;
    return result.value as T;
  }

  const QUOTE_1 = newHash();
  const QUOTE_2 = newHash();

  it("chatCompletion", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    fetchSpy
      .mockResolvedValueOnce(quote402(QUOTE_1))
      .mockResolvedValueOnce(staleRejection())
      .mockResolvedValueOnce(quote402(QUOTE_2))
      .mockResolvedValueOnce(
        json({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "openai/gpt-5.5",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        }),
      );
    await run(client.chatCompletion("openai/gpt-5.5", [{ role: "user", content: "hi" }]));
    expect(signedHashes()).toEqual([QUOTE_1, QUOTE_2]);
  });

  it("stream", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    fetchSpy
      .mockResolvedValueOnce(quote402(QUOTE_1))
      .mockResolvedValueOnce(staleRejection())
      .mockResolvedValueOnce(quote402(QUOTE_2))
      .mockResolvedValueOnce(sse());
    await run(
      (async () => {
        for await (const _ of client.stream("/v1/chat/completions", { model: "x" })) void _;
      })(),
    );
    expect(signedHashes()).toEqual([QUOTE_1, QUOTE_2]);
  });

  it("POST raw routes (exaSearch)", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    fetchSpy
      .mockResolvedValueOnce(quote402(QUOTE_1))
      .mockResolvedValueOnce(staleRejection())
      .mockResolvedValueOnce(quote402(QUOTE_2))
      .mockResolvedValueOnce(json({ results: [] }));
    await run(client.exaSearch("q"));
    expect(signedHashes()).toEqual([QUOTE_1, QUOTE_2]);
  });

  it("GET raw routes (pm)", async () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    fetchSpy
      .mockResolvedValueOnce(quote402(QUOTE_1))
      .mockResolvedValueOnce(staleRejection())
      .mockResolvedValueOnce(quote402(QUOTE_2))
      .mockResolvedValueOnce(json({ markets: [] }));
    await run(client.pm("markets"));
    expect(signedHashes()).toEqual([QUOTE_1, QUOTE_2]);
  });
});
