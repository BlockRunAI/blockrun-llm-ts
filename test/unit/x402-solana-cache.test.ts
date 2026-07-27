import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  createSolanaPaymentPayload,
  __resetSolanaPaymentCaches,
} from "../../src/x402";

// The Solana payment path used to make two RPC round-trips per payment
// (getMint + getLatestBlockhash, ~212ms serial). Both are now cached. These
// tests pin the two properties that make that safe:
//   1. the RPC calls actually disappear from the hot path, and
//   2. reusing a blockhash never emits the same transaction twice — which
//      Solana would reject as an already-processed duplicate.

const FEE_PAYER = Keypair.generate().publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const PAYER = Keypair.generate();

// A blockhash is a 32-byte base58 value; a pubkey is the same shape, so these
// serialize exactly like the real thing.
const HASH_A = Keypair.generate().publicKey.toBase58();
const HASH_B = Keypair.generate().publicKey.toBase58();

/** How many distinct blockhashes the stub hands out, in order. */
function stubConnection(hashes: string[]) {
  const getLatestBlockhash = vi.fn(async () => ({
    blockhash: hashes[Math.min(getLatestBlockhash.mock.calls.length, hashes.length - 1)],
  }));
  const getMint = vi.fn(async () => ({ decimals: 6 }));
  vi.doMock("@solana/web3.js", async () => {
    const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
    return { ...actual, Connection: vi.fn(() => ({ getLatestBlockhash })) };
  });
  vi.doMock("@solana/spl-token", async () => {
    const actual = await vi.importActual<typeof import("@solana/spl-token")>("@solana/spl-token");
    return { ...actual, getMint };
  });
  return { getLatestBlockhash, getMint };
}

async function pay(amount: string, rpcUrl?: string): Promise<string> {
  const raw = await createSolanaPaymentPayload(
    PAYER.secretKey,
    PAYER.publicKey.toBase58(),
    RECIPIENT,
    amount,
    FEE_PAYER,
    rpcUrl ? { rpcUrl } : {},
  );
  return JSON.parse(atob(raw)).payload.transaction as string;
}

describe("Solana payment payload caching", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    __resetSolanaPaymentCaches();
  });

  it("never calls getMint for USDC — decimals is immutable and already known", async () => {
    const { getMint } = stubConnection([HASH_A]);
    await pay("11500");
    await pay("9700");
    expect(getMint).not.toHaveBeenCalled();
  });

  it("reuses one blockhash across payments with different amounts", async () => {
    const { getLatestBlockhash } = stubConnection([HASH_A]);
    await pay("11500");
    await pay("9700");
    await pay("2500");
    expect(getLatestBlockhash).toHaveBeenCalledTimes(1);
  });

  it("does not emit a duplicate transaction for two same-priced payments", async () => {
    // The hazard: identical economics + a reused blockhash compile to a
    // byte-identical message, and ed25519 is deterministic, so both payments
    // would carry the SAME signature and Solana would reject the second.
    stubConnection([HASH_A, HASH_B]);
    const first = await pay("11500");
    const second = await pay("11500");
    expect(second).not.toBe(first);
  });

  it("stays distinct even when the RPC keeps returning the same blockhash", async () => {
    // The default RPC caches getLatestBlockhash for 30s server-side, so a
    // forced refresh can legitimately hand back the same value.
    stubConnection([HASH_A]);
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add(await pay("11500"));
    expect(seen.size).toBe(5);
  });

  it("fails loudly rather than re-emitting a duplicate once the fee-nonce range is spent", async () => {
    // MAX_FEE_NONCE_STEPS is 64, so 65 distinct transactions fit on one
    // blockhash. The 66th cannot: a forced refresh here always returns HASH_A,
    // which getBlockhashEntry correctly resolves to the SAME entry, issued set
    // and all. Rebuilding at the default price there would reproduce payment #1
    // byte for byte and Solana would reject it as already-processed, so the
    // exhausted case has to throw instead.
    stubConnection([HASH_A]);
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
      const { getLatestBlockhash } = stubConnection([HASH_A, HASH_B]);
      await pay("11500");
      vi.advanceTimersByTime(9_000);
      await pay("9700");
      expect(getLatestBlockhash).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      await pay("2500");
      expect(getLatestBlockhash).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a separate blockhash entry per RPC URL", async () => {
    // A client alternating between a primary and a fallback endpoint must not
    // evict the other's entry — that would discard `issued` on every call and
    // silently disable the duplicate guard.
    const { getLatestBlockhash } = stubConnection([HASH_A]);
    const primary = "https://primary.example/rpc";
    const fallback = "https://fallback.example/rpc";

    const first = await pay("11500", primary);
    await pay("11500", fallback);
    const third = await pay("11500", primary);

    // One fetch per URL, and none for the return to the warm primary entry.
    expect(getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(third).not.toBe(first);
  });
});
