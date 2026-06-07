import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RpcClient,
  SUPPORTED_NETWORKS,
  NETWORK_ALIASES,
  RPC_PRICE_USD,
} from "../../src/rpc";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

const RPC_RESULT = { jsonrpc: "2.0", id: 1, result: "0x1499f7c" };

function okResponse(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "x-network": "ethereum", "x-cache": "MISS", ...headers }),
    json: async () => body,
  };
}

describe("RpcClient", () => {
  describe("Constructor", () => {
    it("creates a client with a valid private key", () => {
      const client = new RpcClient({ privateKey: TEST_PRIVATE_KEY });
      expect(client.getWalletAddress()).toBe(
        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
      );
      expect(client.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
    });

    it("throws when no private key is provided", () => {
      const original = process.env.BLOCKRUN_WALLET_KEY;
      delete process.env.BLOCKRUN_WALLET_KEY;
      const originalBase = process.env.BASE_CHAIN_WALLET_KEY;
      delete process.env.BASE_CHAIN_WALLET_KEY;
      try {
        expect(() => new RpcClient({})).toThrow("Private key required");
      } finally {
        if (original !== undefined) process.env.BLOCKRUN_WALLET_KEY = original;
        if (originalBase !== undefined)
          process.env.BASE_CHAIN_WALLET_KEY = originalBase;
      }
    });
  });

  describe("network registry", () => {
    it("mirrors the backend chain registry (40 curated chains)", () => {
      expect(SUPPORTED_NETWORKS).toHaveLength(40);
      expect(new Set(SUPPORTED_NETWORKS).size).toBe(SUPPORTED_NETWORKS.length);
      for (const must of ["ethereum", "base", "solana", "bitcoin", "ripple", "sui"]) {
        expect(SUPPORTED_NETWORKS).toContain(must);
      }
    });

    it("aliases resolve to curated keys", () => {
      for (const [alias, canonical] of Object.entries(NETWORK_ALIASES)) {
        expect(SUPPORTED_NETWORKS, `${alias} -> ${canonical}`).toContain(canonical);
      }
      expect(NETWORK_ALIASES.xrpl).toBe("ripple");
      expect(NETWORK_ALIASES.sol).toBe("solana");
    });

    it("exposes the flat per-call price", () => {
      expect(RPC_PRICE_USD).toBe(0.002);
    });
  });

  describe("requests", () => {
    let client: RpcClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new RpcClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch") as ReturnType<typeof vi.spyOn>;
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("call() posts a JSON-RPC 2.0 body to /v1/rpc/{network}", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(RPC_RESULT) as unknown as Response);

      const result = await client.call("ethereum", "eth_blockNumber");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://blockrun.ai/api/v1/rpc/ethereum");
      expect(JSON.parse(init.body as string)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
      });
      expect(result.result).toBe("0x1499f7c");
      expect(result.network).toBe("ethereum");
      expect(result.cacheHit).toBe(false);
    });

    it("call() includes params when provided", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(RPC_RESULT) as unknown as Response);

      await client.call("base", "eth_getBalance", ["0xabc", "latest"]);

      const body = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
      );
      expect(body.params).toEqual(["0xabc", "latest"]);
    });

    it("call() surfaces cache hits and settlement tx hashes", async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse(RPC_RESULT, {
          "x-cache": "HIT",
          "x-payment-receipt": "0xdeadbeef",
        }) as unknown as Response
      );

      const result = await client.call("ethereum", "eth_chainId");
      expect(result.cacheHit).toBe(true);
      expect(result.txHash).toBe("0xdeadbeef");
    });

    it("call() passes through JSON-RPC error objects", async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "no method" },
        }) as unknown as Response
      );

      const result = await client.call("ethereum", "eth_bogus");
      expect(result.result).toBeUndefined();
      expect(result.error).toEqual({ code: -32601, message: "no method" });
    });

    it("batch() fills jsonrpc/id and returns per-element responses", async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          { jsonrpc: "2.0", id: 1, result: "0x10" },
          { jsonrpc: "2.0", id: 7, result: "0x3b9aca00" },
        ]) as unknown as Response
      );

      const out = await client.batch("polygon", [
        { method: "eth_blockNumber" },
        { method: "eth_gasPrice", id: 7 },
      ]);

      const body = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
      );
      expect(body).toEqual([
        { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" },
        { jsonrpc: "2.0", id: 7, method: "eth_gasPrice" },
      ]);
      expect(out).toHaveLength(2);
      expect(out[1].result).toBe("0x3b9aca00");
    });

    it("batch() rejects an empty request list", async () => {
      await expect(client.batch("ethereum", [])).rejects.toThrow("at least one");
    });

    it("batch() rejects entries with no method", async () => {
      await expect(
        client.batch("ethereum", [{ method: "" }])
      ).rejects.toThrow("missing 'method'");
    });
  });
});
