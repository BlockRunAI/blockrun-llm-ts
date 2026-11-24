import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LLMClient } from "../../src/client";
import { SolanaLLMClient } from "../../src/solana-client";
import { PriceClient } from "../../src/price";
import { APIError } from "../../src/types";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

// Same throwaway key the decisions tests use; never funded.
const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers({ "Content-Type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("on-chain US stock price", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch") as ReturnType<typeof vi.spyOn>;
  });
  afterEach(() => fetchSpy.mockRestore());

  it("SolanaLLMClient.stockPrice GETs the route on its own gateway and returns the whole body", async () => {
    fetchSpy.mockResolvedValue(json(200, { symbol: "TSLA", chain: "solana", price: 386.29, pools: [{ dex: "raydium_clmm" }] }));
    const q = await new SolanaLLMClient({ privateKey: TEST_BS58_KEY }).stockPrice("TSLA");
    const [url] = fetchSpy.mock.calls.at(-1) as [string];
    expect(url).toContain("/v1/stocks/us/price/TSLA");
    expect(url).toContain("sol.blockrun.ai");
    expect(q.chain).toBe("solana");
    expect(q.pools).toHaveLength(1);
  });

  it("a ticker with no on-chain market throws APIError(404) after ONE unpaid request — nothing signed", async () => {
    fetchSpy.mockResolvedValue(json(404, { error: "no_onchain_market", message: "No on-chain market for IBM on Base. Nothing was charged." }));
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await expect(client.stockPrice("IBM")).rejects.toBeInstanceOf(APIError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("payment-signature") ?? headers.get("x-payment")).toBeNull();
  });

  it("PriceClient.price keeps every field and the typed ones win", async () => {
    fetchSpy.mockResolvedValue(json(200, { symbol: "BTC-USD", price: 97000, publishTime: 1, realtime: false, source: "backpack", extraField: "kept" }));
    const p = await new PriceClient({ requireWallet: false }).price("crypto", "BTC-USD");
    expect(p.price).toBe(97000);
    expect(p.realtime).toBe(false);
    expect(p.extraField).toBe("kept");
  });
});
