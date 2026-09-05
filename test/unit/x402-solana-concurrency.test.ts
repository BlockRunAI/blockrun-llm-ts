import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

// Mock the SDK dependency-loader boundary so concurrent dynamic imports never
// bypass the RPC stub. Signing/serialization still use the real Solana library.
const rpc = vi.hoisted(() => ({ blockhash: "", calls: 0, delayMs: 30 }));

vi.mock("../../src/solana-deps.js", async () => {
  const loaders = await vi.importActual<typeof import("../../src/solana-deps.js")>("../../src/solana-deps.js");
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  return {
    ...loaders,
    loadSolanaWeb3: async () => ({
      ...actual,
      Connection: class {
        getLatestBlockhash() {
          rpc.calls++;
          return new Promise<{ blockhash: string }>((resolve) =>
            setTimeout(() => resolve({ blockhash: rpc.blockhash }), rpc.delayMs)
          );
        }
      },
    }),
  };
});

const { createSolanaPaymentPayload, __resetSolanaPaymentCaches } = await import("../../src/x402");

const FEE_PAYER = Keypair.generate().publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const PAYER = Keypair.generate();
const HASH_A = Keypair.generate().publicKey.toBase58();

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

describe("Solana payments fired concurrently", () => {
  beforeEach(() => {
    rpc.blockhash = HASH_A;
    rpc.calls = 0;
    __resetSolanaPaymentCaches();
  });

  it("keeps eight concurrent same-priced payments distinct", async () => {
    // Every one of these is inside getLatestBlockhash at the same moment, so
    // each reads the blockhash cache before any of them has written to it.
    // Reading the cache into a local before that await and trusting it after
    // loses whatever a sibling stored meanwhile: several payments then start
    // from an empty issued set, build the same bytes, and Solana rejects all
    // but the first as already-processed. Measured on that version: 8 payments,
    // 2 to 3 distinct.
    const txs = await Promise.all(Array.from({ length: 8 }, () => pay("11500")));
    expect(new Set(txs).size).toBe(8);
  });

  it("reuses the cached blockhash after a cold concurrent burst", async () => {
    // The cache stores completed RPC results, not in-flight promises. Every
    // cold caller can legitimately fetch before the first result arrives.
    // The stable guarantee is that a warm burst performs no additional RPC.
    await Promise.all(Array.from({ length: 8 }, (_, i) => pay(String(10_000 + i))));
    const coldCalls = rpc.calls;
    expect(coldCalls).toBeGreaterThan(0);
    expect(coldCalls).toBeLessThanOrEqual(8);
    const warm = await Promise.all(Array.from({ length: 8 }, () => pay("11500")));
    expect(rpc.calls).toBe(coldCalls);
    expect(new Set(warm).size).toBe(8);
  });
});

describe("bounded memory", () => {
  beforeEach(() => {
    rpc.blockhash = HASH_A;
    rpc.calls = 0;
    rpc.delayMs = 0;
    __resetSolanaPaymentCaches();
  });

  it("keeps guarding the blockhash in use after many rotations", async () => {
    // Both maps are pruned to a small window. Pruning must never drop what is
    // in use right now, or the duplicate guard silently stops working on the
    // hot path. A distinct URL per round forces a real fetch, so the blockhash
    // genuinely rotates and both windows overflow several times over.
    const ROUNDS = 20;
    for (let i = 0; i < ROUNDS; i++) {
      rpc.blockhash = Keypair.generate().publicKey.toBase58();
      await pay("11500", `https://rpc-${i}.example/rpc`);
    }
    // Guard against a vacuous run: without a fetch per round nothing rotated
    // and this test would prove nothing.
    expect(rpc.calls).toBe(ROUNDS);

    const url = `https://rpc-${ROUNDS - 1}.example/rpc`;
    const first = await pay("9700", url);
    const second = await pay("9700", url);
    expect(second).not.toBe(first);
  });
});
