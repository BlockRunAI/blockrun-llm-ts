import { afterEach, describe, expect, it, vi } from "vitest";
import { PriceClient } from "../../src/price";
import { APIError } from "../../src/types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("PriceClient", () => {
  it("keeps the gateway's realtime flag and note on a price", async () => {
    // As blockrun.ai answered GET /v1/crypto/price/BTC-USD on 2026-11-15.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      symbol: "BTC-USD", category: "crypto", price: 64691, publishTime: 1794766775,
      timestamp: "2026-11-15T18:19:35.000Z", assetType: "crypto", source: "backpack",
      realtime: false, note: "Daily close, not realtime.", free: true,
    }));
    const p = new PriceClient({ requireWallet: false });
    const btc = await p.price("crypto", "BTC-USD");
    expect(btc).toMatchObject({ price: 64691, source: "backpack", realtime: false, note: "Daily close, not realtime.", free: true });
  });

  it("surfaces a stock price's 501 as an APIError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      error: "US Stock price is not available", category: "stocks/us", symbol: "AAPL",
      note: "We do not currently serve equity prices.",
    }, 501));
    const p = new PriceClient({ requireWallet: false });
    const err = await p.price("stocks", "AAPL", { market: "us" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(501);
  });
});
