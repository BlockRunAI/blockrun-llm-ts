import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LLMClient } from "../../src/client";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    json: async () => body,
  };
}

const VALID_ADDRESS = "0x1234567890abcdefABCDEF1234567890abcdef12";
const ONRAMP_URL = "https://pay.coinbase.com/buy/select-asset?sessionToken=tok";

describe("onramp() — Coinbase Onramp link", () => {
  let client: LLMClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    fetchSpy = vi.spyOn(global, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(okResponse({ url: ONRAMP_URL }) as unknown as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function lastCall(): { url: string; init: RequestInit } {
    const [url, init] = fetchSpy.mock.calls.at(-1) as [string, RequestInit];
    return { url, init };
  }

  it("POSTs /v1/onramp/token with {address, network, asset} and returns the url", async () => {
    const result = await client.onramp(VALID_ADDRESS);
    const { url, init } = lastCall();
    expect(url).toContain("/v1/onramp/token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      address: VALID_ADDRESS,
      network: "base",
      asset: "USDC",
    });
    expect(result).toEqual({ url: ONRAMP_URL });
  });

  it("rejects a blank address without calling the gateway", async () => {
    await expect(client.onramp("")).rejects.toThrow(/address/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed address without calling the gateway", async () => {
    await expect(client.onramp("0x123")).rejects.toThrow(/address/i);
    await expect(client.onramp("not-an-address")).rejects.toThrow(/address/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-coinbase url returned by the gateway", async () => {
    fetchSpy.mockResolvedValue(
      okResponse({ url: "https://evil.example.com/phish" }) as unknown as Response
    );
    await expect(client.onramp(VALID_ADDRESS)).rejects.toThrow(/no onramp url/i);
  });

  it("rejects when the gateway omits the url", async () => {
    fetchSpy.mockResolvedValue(okResponse({}) as unknown as Response);
    await expect(client.onramp(VALID_ADDRESS)).rejects.toThrow(/no onramp url/i);
  });
});
