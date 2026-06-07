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

describe("DefiLlama / 0x DEX / Modal passthrough methods", () => {
  let client: LLMClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    fetchSpy = vi.spyOn(global, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(okResponse({ ok: true }) as unknown as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function lastCall(): { url: string; init: RequestInit } {
    const [url, init] = fetchSpy.mock.calls.at(-1) as [string, RequestInit];
    return { url, init };
  }

  it("defi() GETs /v1/defillama/{path} with query params", async () => {
    await client.defi("yields", { chain: "Base" });
    const { url, init } = lastCall();
    expect(url).toContain("/v1/defillama/yields");
    expect(url).toContain("chain=Base");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("defi conveniences hit the documented paths", async () => {
    await client.defiProtocols();
    expect(lastCall().url).toContain("/v1/defillama/protocols");
    await client.defiProtocol("aave");
    expect(lastCall().url).toContain("/v1/defillama/protocol/aave");
    await client.defiChains();
    expect(lastCall().url).toContain("/v1/defillama/chains");
  });

  it("defiPrices joins coin lists", async () => {
    await client.defiPrices(["coingecko:bitcoin", "base:0xabc"]);
    expect(lastCall().url).toContain(
      "/v1/defillama/prices/coingecko:bitcoin,base:0xabc"
    );
  });

  it("dexQuote GETs /v1/zerox/quote with swap params", async () => {
    await client.dexQuote({ chainId: "8453", sellToken: "0xa", buyToken: "0xb" });
    const { url } = lastCall();
    expect(url).toContain("/v1/zerox/quote");
    expect(url).toContain("chainId=8453");
  });

  it("dexGaslessSubmit POSTs the signed trade body", async () => {
    await client.dexGaslessSubmit({ trade: { signature: "0xsig" } });
    const { url, init } = lastCall();
    expect(url).toContain("/v1/zerox/gasless/submit");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ trade: { signature: "0xsig" } });
  });

  it("dexGaslessStatus embeds the trade hash in the path", async () => {
    await client.dexGaslessStatus("0xtradehash");
    expect(lastCall().url).toContain("/v1/zerox/gasless/status/0xtradehash");
  });

  it("modal lifecycle POSTs to the sandbox endpoints", async () => {
    await client.modalSandboxCreate({ image: "python:3.11" });
    let { url, init } = lastCall();
    expect(url).toContain("/v1/modal/sandbox/create");
    expect(JSON.parse(init.body as string)).toEqual({ image: "python:3.11" });

    await client.modalSandboxExec("sb_123", ["python", "-c", "print(1)"]);
    ({ url, init } = lastCall());
    expect(url).toContain("/v1/modal/sandbox/exec");
    const body = JSON.parse(init.body as string);
    expect(body.sandbox_id).toBe("sb_123");
    expect(body.command).toEqual(["python", "-c", "print(1)"]);

    await client.modalSandboxTerminate("sb_123");
    ({ url } = lastCall());
    expect(url).toContain("/v1/modal/sandbox/terminate");
  });
});
