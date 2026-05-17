import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BlockrunClient } from "../../src/blockrun";
import { APIError, PaymentError } from "../../src/types";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

describe("BlockrunClient", () => {
  describe("Constructor", () => {
    it("creates a client with a valid private key", () => {
      const client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      expect(client.getWalletAddress()).toBe(
        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
      );
    });

    it("starts with zero spending", () => {
      const client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      const spending = client.getSpending();
      expect(spending.totalUsd).toBe(0);
      expect(spending.calls).toBe(0);
    });

    it("throws when no private key is provided", () => {
      const original = process.env.BLOCKRUN_WALLET_KEY;
      const originalBase = process.env.BASE_CHAIN_WALLET_KEY;
      delete process.env.BLOCKRUN_WALLET_KEY;
      delete process.env.BASE_CHAIN_WALLET_KEY;
      try {
        expect(() => new BlockrunClient({})).toThrow("Private key required");
      } finally {
        if (original !== undefined) process.env.BLOCKRUN_WALLET_KEY = original;
        if (originalBase !== undefined)
          process.env.BASE_CHAIN_WALLET_KEY = originalBase;
      }
    });

    it("rejects malformed private keys", () => {
      expect(
        () => new BlockrunClient({ privateKey: "not-hex" as `0x${string}` })
      ).toThrow();
    });
  });

  describe("URL composition", () => {
    let client: BlockrunClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("composes the URL by appending path to apiUrl", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ price: 100 }),
      } as Response);

      await client.get("/v1/surf/market/price", { symbol: "BTC" });

      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe(
        "https://blockrun.ai/api/v1/surf/market/price?symbol=BTC"
      );
    });

    it("strips a leading /api if the caller includes it", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response);

      await client.get("/api/v1/chat/completions");
      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe("https://blockrun.ai/api/v1/chat/completions");
    });

    it("serializes array params as repeated keys", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response);

      await client.get("/v1/surf/search/web", {
        q: "x402",
        domains: ["a.com", "b.com"],
      });

      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toContain("q=x402");
      expect(calledUrl).toContain("domains=a.com");
      expect(calledUrl).toContain("domains=b.com");
    });

    it("drops undefined/null params", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response);

      await client.get("/v1/surf/market/price", {
        symbol: "ETH",
        chain: undefined,
        provider: null,
      });

      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe(
        "https://blockrun.ai/api/v1/surf/market/price?symbol=ETH"
      );
    });
  });

  describe("post", () => {
    let client: BlockrunClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
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

      await client.post("/v1/surf/onchain/sql", { query: "SELECT 1" });

      const [, init] = fetchSpy.mock.calls[0];
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      expect(
        (reqInit.headers as Record<string, string>)["Content-Type"]
      ).toBe("application/json");
      expect(JSON.parse(String(reqInit.body))).toEqual({ query: "SELECT 1" });
    });

    it("throws APIError on non-402 failures", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      } as Response);

      await expect(client.post("/v1/surf/onchain/sql")).rejects.toThrow(
        APIError
      );
    });

    it("throws PaymentError on 402 with no payment requirements", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 402,
        headers: new Headers(),
        json: async () => ({}),
      } as unknown as Response);

      await expect(client.post("/v1/anything")).rejects.toThrow(PaymentError);
    });
  });

  describe("poll", () => {
    let client: BlockrunClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("short-circuits when the gateway answers 200 on submit (free / pre-authed)", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ url: "https://cdn/clip.mp4" }] }),
      } as Response);

      const result = await client.poll<{ data: unknown[] }>("/v1/videos/generations", {
        prompt: "test",
      });

      expect(result.data).toBeDefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("times out and throws when budget is exceeded with no completion", async () => {
      const tinyBudgetClient = new BlockrunClient({
        privateKey: TEST_PRIVATE_KEY,
      });

      // Flow: POST without sig → 402 (payment required)
      //       POST with PAYMENT-SIGNATURE → 202 { id, poll_url }
      //       GET poll_url → 202 { status: "in_progress" }  (forever)
      fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const headers = (init?.headers as Record<string, string>) || {};
        const hasSig = "PAYMENT-SIGNATURE" in headers;

        if (method === "POST" && !hasSig) {
          return {
            ok: false,
            status: 402,
            headers: new Headers({
              "payment-required": btoa(
                JSON.stringify({
                  x402Version: 2,
                  accepts: [
                    {
                      scheme: "exact",
                      network: "eip155:8453",
                      amount: "1000",
                      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                      payTo: "0x000000000000000000000000000000000000dEaD",
                      maxTimeoutSeconds: 300,
                    },
                  ],
                })
              ),
            }),
            json: async () => ({}),
          } as unknown as Response;
        }

        if (method === "POST" && hasSig) {
          return {
            ok: true,
            status: 202,
            json: async () => ({
              id: "job-123",
              poll_url: "/v1/videos/generations/job-123",
              status: "queued",
            }),
            headers: new Headers(),
          } as unknown as Response;
        }

        // GET poll — always in_progress
        return {
          ok: true,
          status: 202,
          json: async () => ({ status: "in_progress" }),
          headers: new Headers(),
        } as unknown as Response;
      });

      await expect(
        tinyBudgetClient.poll("/v1/videos/generations", { prompt: "test" }, {
          budgetMs: 50,
          intervalMs: 10,
        })
      ).rejects.toThrow(/did not complete/);
    });
  });

  describe("stream", () => {
    let client: BlockrunClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new BlockrunClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("parses SSE chunks and stops on [DONE]", async () => {
      const sseBody = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        "data: [DONE]",
        "",
      ].join("\n");

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseBody));
          controller.close();
        },
      });

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: stream,
      } as unknown as Response);

      const chunks: Array<{ choices: Array<{ delta: { content: string } }> }> =
        [];
      for await (const chunk of client.stream<{
        choices: Array<{ delta: { content: string } }>;
      }>("/v1/chat/completions", {
        model: "test",
        messages: [],
        stream: true,
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].choices[0].delta.content).toBe("Hello");
      expect(chunks[1].choices[0].delta.content).toBe(" world");
    });

    it("skips malformed JSON lines without crashing", async () => {
      const sseBody = [
        'data: {"valid":1}',
        "data: this is not json",
        'data: {"valid":2}',
        "data: [DONE]",
        "",
      ].join("\n");

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseBody));
          controller.close();
        },
      });

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: stream,
      } as unknown as Response);

      const chunks: Array<{ valid: number }> = [];
      for await (const chunk of client.stream<{ valid: number }>(
        "/v1/chat/completions",
        { stream: true }
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([{ valid: 1 }, { valid: 2 }]);
    });
  });
});
