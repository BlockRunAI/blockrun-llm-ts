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

async function pay(amount: string): Promise<string> {
  const raw = await createSolanaPaymentPayload(
    PAYER.secretKey,
    PAYER.publicKey.toBase58(),
    RECIPIENT,
    amount,
    FEE_PAYER,
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
});
