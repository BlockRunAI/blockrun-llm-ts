import { describe, it, expect } from "vitest";
import { SolanaLLMClient } from "../../src/solana-client";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

describe("SolanaLLMClient", () => {
  it("initializes with bs58 private key", () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    expect(client).toBeTruthy();
  });

  it("throws if no private key provided and no env var", () => {
    const savedKey = process.env.SOLANA_WALLET_KEY;
    delete process.env.SOLANA_WALLET_KEY;
    expect(() => new SolanaLLMClient()).toThrow(/private key required/i);
    if (savedKey) process.env.SOLANA_WALLET_KEY = savedKey;
  });

  it("uses sol.blockrun.ai as default API URL", () => {
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    expect(client.isSolana()).toBe(true);
  });

  it("uses custom API URL when provided", () => {
    const client = new SolanaLLMClient({
      privateKey: TEST_BS58_KEY,
      apiUrl: "https://custom.example.com/api",
    });
    expect(client.isSolana()).toBe(false);
  });

  it("reads private key from SOLANA_WALLET_KEY env var", () => {
    process.env.SOLANA_WALLET_KEY = TEST_BS58_KEY;
    const client = new SolanaLLMClient();
    expect(client).toBeTruthy();
    delete process.env.SOLANA_WALLET_KEY;
  });
});
