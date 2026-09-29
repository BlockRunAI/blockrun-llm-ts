// The Solana wallet path used to hand a 202 envelope back as if it were the
// result: a caller asking for an image got a job id, and nothing ever settled.
// The second test pins the other half — that the EVM client refuses a Solana
// challenge outright rather than replaying one EIP-3009 signature across polls,
// which could not work where a payment expires with its blockhash (~60s).
import { describe, it, expect, vi, beforeEach } from "vitest";

const WALLET = "So11111111111111111111111111111111111111112";

vi.mock("../src/solana-wallet.js", () => ({
  solanaKeyToBytes: vi.fn(async () => new Uint8Array(64)),
  solanaPublicKey: vi.fn(async () => WALLET),
}));

const signed: string[] = [];
vi.mock("../src/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/x402.js")>();
  return {
    ...actual,
    createSolanaPaymentPayload: vi.fn(async () => {
      // a real payload is pinned to a blockhash; a distinct value per call is
      // what lets the test see whether the client re-signed or replayed
      const tx = `signed-tx-${signed.length}`;
      signed.push(tx);
      return tx;
    }),
  };
});

const CHALLENGE = {
  x402Version: 2,
  accepts: [{
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    maxAmountRequired: "40000",
    payTo: WALLET,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    maxTimeoutSeconds: 300,
    resource: { url: "https://sol.blockrun.ai/api/v1/images/generations" },
    extra: { feePayer: WALLET, recentBlockhash: "HASH" },
  }],
};

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as Response;
}

describe("Solana async jobs", () => {
  beforeEach(() => { signed.length = 0; vi.restoreAllMocks(); });

  it("follows 202 -> poll -> completed, signing afresh on every poll", async () => {
    const { SolanaLLMClient } = await import("../src/solana-client.js");
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const paid = Boolean((init?.headers as Record<string, string>)?.["PAYMENT-SIGNATURE"]);
      calls.push(`${init?.method ?? "GET"}|${paid ? "P" : "U"}|${url}`);
      if (url.includes("/images/generations") && init?.method === "POST") {
        return paid
          ? res(202, { id: "job1", poll_url: "/v1/images/generations/job1", status: "queued" })
          : res(402, CHALLENGE);
      }
      // the poll: unpaid -> fresh 402, paid -> queued once, then completed
      if (!paid) return res(402, CHALLENGE);
      const nth = calls.filter((c) => c.startsWith("GET|P|")).length;
      return nth < 2
        ? res(202, { id: "job1", status: "in_progress" })
        : res(200, { id: "job1", status: "completed", data: [{ url: "https://x/y.png" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SolanaLLMClient({ privateKey: "k", timeout: 20_000 });
    const out = await (client as unknown as {
      requestWithPaymentRaw(e: string, b: Record<string, unknown>): Promise<Record<string, unknown>>;
    }).requestWithPaymentRaw("/v1/images/generations", { prompt: "a cat" });

    expect(out.status).toBe("completed");
    // Solana settles at POST, not on the completed poll. The cost must be
    // recorded once, at submit — recording it on completion would drop the
    // charge whenever a paid job later fails.
    const spend = (client as unknown as { getSpending(): { totalUsd: number; calls: number } }).getSpending?.();
    if (spend) expect(spend.calls).toBe(1);
    // one signature for the submit + one per poll, all distinct: nothing replayed
    expect(signed.length).toBeGreaterThanOrEqual(3);
    expect(new Set(signed).size).toBe(signed.length);
  }, 30_000);

  it("the EVM client refuses a Solana challenge instead of replaying a signature", async () => {
    const { BlockrunClient } = await import("../src/blockrun.js");
    vi.stubGlobal("fetch", vi.fn(async () => res(402, CHALLENGE)));
    const br = new BlockrunClient({
      apiUrl: "https://sol.blockrun.ai/api",
      privateKey: "0x" + "1".repeat(64),
    } as never);
    await expect(
      br.poll("/v1/videos/generations", { prompt: "x" })
    ).rejects.toThrow(/Unsupported x402 network "solana/i);
  }, 20_000);
});
