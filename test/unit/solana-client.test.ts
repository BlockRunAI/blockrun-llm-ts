import { describe, it, expect, vi, afterEach } from "vitest";
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

describe("SolanaLLMClient RPC resolution", () => {
  const envBackup: Record<string, string | undefined> = {};
  const savedKeys = ["SOLANA_RPC_URL", "SOLANA_RPC_API_KEY", "SOLANA_RPC_HEADERS"];

  function clearRpcEnv() {
    for (const k of savedKeys) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  }

  function restoreRpcEnv() {
    for (const k of savedKeys) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  }

  afterEach(() => {
    restoreRpcEnv();
    vi.restoreAllMocks();
  });

  it("defaults to BlockRun's Solana RPC proxy when no override is given", async () => {
    clearRpcEnv();
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { value: [] } }),
    } as Response);

    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    // Skip real key decoding — RPC resolution is independent of the wallet
    vi.spyOn(client, "getWalletAddress").mockResolvedValue(
      "11111111111111111111111111111111"
    );
    await client.getBalance();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://sol.blockrun.ai/api/v1/solana/rpc"
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("honors SOLANA_RPC_URL env var", async () => {
    clearRpcEnv();
    process.env.SOLANA_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=foo";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { value: [] } }),
    } as Response);

    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    // Skip real key decoding — RPC resolution is independent of the wallet
    vi.spyOn(client, "getWalletAddress").mockResolvedValue(
      "11111111111111111111111111111111"
    );
    await client.getBalance();

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://mainnet.helius-rpc.com/?api-key=foo"
    );
  });

  it("translates SOLANA_RPC_API_KEY into an x-api-key header", async () => {
    clearRpcEnv();
    process.env.SOLANA_RPC_URL = "https://solana-mainnet.gateway.tatum.io";
    process.env.SOLANA_RPC_API_KEY = "t-secret";

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { value: [] } }),
    } as Response);

    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    // Skip real key decoding — RPC resolution is independent of the wallet
    vi.spyOn(client, "getWalletAddress").mockResolvedValue(
      "11111111111111111111111111111111"
    );
    await client.getBalance();

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("t-secret");
  });

  it("parses SOLANA_RPC_HEADERS JSON into request headers", async () => {
    clearRpcEnv();
    process.env.SOLANA_RPC_URL = "https://your.gateway/";
    process.env.SOLANA_RPC_HEADERS = JSON.stringify({
      "x-api-key": "abc",
      "x-rate-tier": "pro",
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { value: [] } }),
    } as Response);

    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    // Skip real key decoding — RPC resolution is independent of the wallet
    vi.spyOn(client, "getWalletAddress").mockResolvedValue(
      "11111111111111111111111111111111"
    );
    await client.getBalance();

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("abc");
    expect(headers["x-rate-tier"]).toBe("pro");
  });

  it("explicit rpcUrl + rpcHeaders options beat env vars", async () => {
    clearRpcEnv();
    process.env.SOLANA_RPC_URL = "https://ignored.example/";
    process.env.SOLANA_RPC_API_KEY = "ignored";

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { value: [] } }),
    } as Response);

    const client = new SolanaLLMClient({
      privateKey: TEST_BS58_KEY,
      rpcUrl: "https://chosen.example/rpc",
      rpcHeaders: { "x-chosen": "yes" },
    });
    vi.spyOn(client, "getWalletAddress").mockResolvedValue(
      "11111111111111111111111111111111"
    );
    await client.getBalance();

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://chosen.example/rpc"
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-chosen"]).toBe("yes");
    expect(headers["x-api-key"]).toBeUndefined();
  });
});
