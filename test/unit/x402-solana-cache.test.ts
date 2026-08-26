import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

// The Solana payment path used to make two RPC round-trips per payment
// (getMint + getLatestBlockhash, ~212ms serial). Both are gone. These tests pin
// the two properties that make that safe:
//   1. the RPC calls actually disappear from the hot path, and
//   2. reusing a blockhash never emits the same transaction twice — which
//      Solana would reject as an already-processed duplicate.
//
// The mocks are hoisted rather than registered per test with `vi.doMock` +
// `vi.resetModules()`. That older pattern rebuilds the module registry while
// `createSolanaPaymentPayload`'s dynamic `import("@solana/web3.js")` may already
// be in flight, and some imports then resolve to the REAL module — building a
// real Connection and calling the live gateway. A hoisted mock is installed once,
// before anything imports, so these tests can never reach the network.
const rpc = vi.hoisted(() => ({
  /** Blockhashes handed out in order; the last one repeats forever. */
  hashes: [] as string[],
  blockhashCalls: 0,
  mintCalls: 0,
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

vi.mock("@solana/spl-token", async () => {
  const actual = await vi.importActual<typeof import("@solana/spl-token")>("@solana/spl-token");
  return {
    ...actual,
    getMint: async () => {
      rpc.mintCalls++;
      return { decimals: 6 };
    },
  };
});

const { createSolanaPaymentPayload, __resetSolanaPaymentCaches } = await import("../../src/x402");

const FEE_PAYER = Keypair.generate().publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const PAYER = Keypair.generate();

// A blockhash is a 32-byte base58 value; a pubkey is the same shape, so these
// serialize exactly like the real thing.
const HASH_A = Keypair.generate().publicKey.toBase58();
const HASH_B = Keypair.generate().publicKey.toBase58();

async function pay(
  amount: string,
  rpcUrl?: string,
  forceFreshBlockhash?: boolean,
): Promise<string> {
  const raw = await createSolanaPaymentPayload(
    PAYER.secretKey,
    PAYER.publicKey.toBase58(),
    RECIPIENT,
    amount,
    FEE_PAYER,
    { ...(rpcUrl ? { rpcUrl } : {}), ...(forceFreshBlockhash ? { forceFreshBlockhash } : {}) },
  );
  return JSON.parse(atob(raw)).payload.transaction as string;
}

describe("Solana payment payload caching", () => {
  beforeEach(() => {
    rpc.hashes = [HASH_A];
    rpc.blockhashCalls = 0;
    rpc.mintCalls = 0;
    __resetSolanaPaymentCaches();
  });

  it("never calls getMint for USDC — decimals is immutable and already known", async () => {
    await pay("11500");
    await pay("9700");
    expect(rpc.mintCalls).toBe(0);
  });

  it("reuses one blockhash across payments with different amounts", async () => {
    await pay("11500");
    await pay("9700");
    await pay("2500");
    expect(rpc.blockhashCalls).toBe(1);
  });

  it("does not emit a duplicate transaction for two same-priced payments", async () => {
    // The hazard: identical economics + a reused blockhash compile to a
    // byte-identical message, and ed25519 is deterministic, so both payments
    // would carry the SAME signature and Solana would reject the second.
    rpc.hashes = [HASH_A, HASH_B];
    const first = await pay("11500");
    const second = await pay("11500");
    expect(second).not.toBe(first);
  });

  // A stale-blockhash rejection means the hash this client signed against has
  // expired. The client cache TTL is 10s and the SDK's retry backoffs total
  // 2.5s, so a re-sign that does NOT force a refresh is served the same expired
  // hash — and the duplicate guard nudges the priority fee, so the bytes differ
  // and the retry looks productive while being pinned to the very blockhash the
  // server just rejected. `forceFreshBlockhash` is what makes it real.
  describe("forceFreshBlockhash (stale-blockhash re-sign)", () => {
    it("without it, a re-sign is served the same expired blockhash from cache", async () => {
      rpc.hashes = [HASH_A, HASH_B];
      const first = await pay("11500");
      const second = await pay("11500");
      expect(rpc.blockhashCalls).toBe(1);
      // Different bytes, same blockhash — the failure mode this pins.
      expect(second).not.toBe(first);
    });

    it("with it, the client asks the RPC for a current blockhash", async () => {
      rpc.hashes = [HASH_A, HASH_B];
      await pay("11500");
      await pay("11500", undefined, true);
      expect(rpc.blockhashCalls).toBe(2);
    });

    it("still emits distinct bytes when the forced refresh returns the same hash", async () => {
      // The RPC caches getLatestBlockhash 30s server-side, so a forced refresh
      // can legitimately hand back the value that just failed. The duplicate
      // guard must still hold, or the re-sign is rejected as already-processed
      // instead of as stale.
      rpc.hashes = [HASH_A];
      const first = await pay("11500");
      const second = await pay("11500", undefined, true);
      expect(rpc.blockhashCalls).toBe(2);
      expect(second).not.toBe(first);
    });
  });

  it("stays distinct even when the RPC keeps returning the same blockhash", async () => {
    // The default RPC caches getLatestBlockhash for 30s server-side, so a
    // forced refresh can legitimately hand back the same value.
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add(await pay("11500"));
    expect(seen.size).toBe(5);
  });

  it("fails loudly rather than re-emitting a duplicate once the fee-nonce range is spent", async () => {
    // MAX_FEE_NONCE_STEPS is 64, so 65 distinct transactions fit on one
    // blockhash. The 66th cannot: a forced refresh here always returns HASH_A,
    // and the issued record is keyed by blockhash so it survives the refresh.
    // Rebuilding at the default price would reproduce payment #1 byte for byte
    // and Solana would reject it as already-processed, so this has to throw.
    const seen = new Set<string>();
    for (let i = 0; i < 65; i++) seen.add(await pay("11500"));
    expect(seen.size).toBe(65);

    await expect(pay("11500")).rejects.toThrow(/65 identical payments already issued/);

    // A different amount is unaffected — the range is per-economics, not global.
    expect(seen.has(await pay("9700"))).toBe(false);
  });

  it("refetches once the blockhash TTL expires", async () => {
    // BLOCKHASH_TTL_MS is 10s. Nothing should hit the network before that.
    vi.useFakeTimers();
    try {
      rpc.hashes = [HASH_A, HASH_B];
      await pay("11500");
      vi.advanceTimersByTime(9_000);
      await pay("9700");
      expect(rpc.blockhashCalls).toBe(1);

      vi.advanceTimersByTime(2_000);
      await pay("2500");
      expect(rpc.blockhashCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a separate blockhash entry per RPC URL", async () => {
    // A client alternating between a primary and a fallback endpoint must not
    // evict the other's entry, or every call refetches.
    const primary = "https://primary.example/rpc";
    const fallback = "https://fallback.example/rpc";

    await pay("11500", primary);
    await pay("11500", fallback);
    await pay("11500", primary);

    // One fetch per URL, and none for the return to the warm primary entry.
    expect(rpc.blockhashCalls).toBe(2);
  });

  it("does not repeat bytes across two endpoints serving the same blockhash", async () => {
    // Solana never sees which URL served the blockhash — a transaction's
    // identity is its blockhash plus its economics. Filing the issued record
    // per endpoint let the fallback start from an empty record and re-emit the
    // primary's exact bytes, which is a duplicate the network rejects.
    const first = await pay("11500", "https://primary.example/rpc");
    const second = await pay("11500", "https://fallback.example/rpc");
    expect(second).not.toBe(first);
  });
});
