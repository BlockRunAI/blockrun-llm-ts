import { describe, it, expect } from "vitest";
import {
  createSolanaWallet,
  solanaKeyToBytes,
  getOrCreateSolanaWallet,
} from "../../src/solana-wallet";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

describe("Solana Wallet", () => {
  it("createSolanaWallet returns address and privateKey", () => {
    const wallet = createSolanaWallet();
    expect(wallet.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58
    expect(wallet.privateKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/); // bs58 64-byte key
  });

  it("solanaKeyToBytes converts bs58 key to Uint8Array", async () => {
    const bytes = await solanaKeyToBytes(TEST_BS58_KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(64);
  });

  it("solanaKeyToBytes throws on invalid key", async () => {
    await expect(solanaKeyToBytes("invalid-key")).rejects.toThrow();
  });
});
