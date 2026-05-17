import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SurfClient } from "../../src/surf";
import { APIError, PaymentError } from "../../src/types";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

describe("SurfClient", () => {
  describe("Constructor", () => {
    it("creates a client with a valid private key", () => {
      const client = new SurfClient({ privateKey: TEST_PRIVATE_KEY });
      expect(client.getWalletAddress()).toBe(
        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
      );
    });

    it("throws when no private key is provided", () => {
      const original = process.env.BLOCKRUN_WALLET_KEY;
      delete process.env.BLOCKRUN_WALLET_KEY;
      const originalBase = process.env.BASE_CHAIN_WALLET_KEY;
      delete process.env.BASE_CHAIN_WALLET_KEY;
      try {
        expect(() => new SurfClient({})).toThrow("Private key required");
      } finally {
        if (original !== undefined) process.env.BLOCKRUN_WALLET_KEY = original;
        if (originalBase !== undefined)
          process.env.BASE_CHAIN_WALLET_KEY = originalBase;
      }
    });

    it("rejects malformed private keys", () => {
      expect(
        () => new SurfClient({ privateKey: "not-hex" as `0x${string}` })
      ).toThrow();
    });
  });

  describe("get / URL construction", () => {
    let client: SurfClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new SurfClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("prepends /v1/surf when the path omits it", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ price: 100 }),
      } as Response);

      await client.get("/market/price", { symbol: "BTC" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe(
        "https://blockrun.ai/api/v1/surf/market/price?symbol=BTC"
      );
    });

    it("does not double up /v1/surf when caller already included it", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response);

      await client.get("/v1/surf/news/feed");
      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe("https://blockrun.ai/api/v1/surf/news/feed");
    });

    it("serializes array params as repeated keys", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response);

      await client.get("/search/web", {
        q: "x402",
        domains: ["coindesk.com", "theblock.co"],
      });

      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toContain("q=x402");
      expect(calledUrl).toContain("domains=coindesk.com");
      expect(calledUrl).toContain("domains=theblock.co");
    });

    it("drops undefined/null params", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response);

      await client.get("/market/price", {
        symbol: "ETH",
        chain: undefined,
        provider: null,
      });

      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe(
        "https://blockrun.ai/api/v1/surf/market/price?symbol=ETH"
      );
    });

    it("throws APIError on non-402 failures", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      } as Response);

      await expect(client.get("/market/price")).rejects.toThrow(APIError);
    });
  });

  describe("post", () => {
    let client: SurfClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new SurfClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("sends a JSON body with the correct Content-Type", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ rows: [] }),
      } as Response);

      await client.post("/onchain/sql", { query: "SELECT 1" });

      const [, init] = fetchSpy.mock.calls[0];
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      expect(
        (reqInit.headers as Record<string, string>)["Content-Type"]
      ).toBe("application/json");
      expect(JSON.parse(String(reqInit.body))).toEqual({ query: "SELECT 1" });
    });
  });

  describe("402 payment flow", () => {
    let client: SurfClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new SurfClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("throws PaymentError on 402 with no payment requirements", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 402,
        headers: new Headers(),
        json: async () => ({}),
      } as unknown as Response);

      await expect(client.get("/market/price")).rejects.toThrow(PaymentError);
    });
  });
});
