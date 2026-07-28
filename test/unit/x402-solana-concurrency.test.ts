import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

// Concurrency lives in its own file on purpose.
//
// The sibling caching tests use `vi.doMock` + `vi.resetModules()` per test.
// That is fine for sequential payments, but under `Promise.all` the mock
// registry is being rebuilt while several dynamic `import("@solana/web3.js")`
// calls are already in flight, and some of them resolve to the REAL module —
// at which point the test quietly builds a real Connection and calls the live
// gateway. It shows up as blockhashes the stub never returned, and as ~30%
// flakiness. A hoisted `vi.mock` applies to every dynamic import up front, with
// no reset racing against it, so this file can never reach the network.
const rpc = vi.hoisted(() => ({ blockhash: "", calls: 0, delayMs: 30 }));

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  return {
    ...actual,
    // Answers slowly, like a real RPC (~107ms against sol.blockrun.ai). An
    // instant stub lets each payment finish before the next one starts, which
    // hides every interleaving this file exists to catch.
    Connection: class {
      getLatestBlockhash() {
        rpc.calls++;
        return new Promise<{ blockhash: string }>((resolve) =>
          setTimeout(() => resolve({ blockhash: rpc.blockhash }), rpc.delayMs)
        );
      }
    },
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

  it("shares one fetched blockhash across the whole burst", async () => {
    // The burst overlaps, so a few calls legitimately race to the RPC before
    // the first result lands. What must NOT happen is one fetch per payment —
    // that is the round-trip this caching removed.
    await Promise.all(Array.from({ length: 8 }, (_, i) => pay(String(10_000 + i))));
    expect(rpc.calls).toBeLessThan(8);
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
