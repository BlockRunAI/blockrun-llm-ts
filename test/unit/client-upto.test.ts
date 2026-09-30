import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/cost-log", () => ({ logCost: vi.fn(), getCostSummary: vi.fn() }));

import { LLMClient } from "../../src/client";
import { OpenAI } from "../../src/openai-compat";
import { logCost } from "../../src/cost-log";
import { USDC_BASE } from "../../src/x402";
import { TEST_PRIVATE_KEY, TEST_RECIPIENT, buildChatResponse } from "../helpers/testHelpers";

/**
 * End-to-end through LLMClient: a 402 offering exact (accepts[0]) + upto
 * (accepts[1]) is paid with upto when the wallet can, and the spend recorded
 * is the SETTLED amount when the gateway reports one — never the ceiling
 * passed off as a payment.
 */
const RPC = "https://rpc.test";
const FACILITATOR = "0x97AcCe27D5069544480BDe0F04D9F47d7422a016";

function paymentRequiredHeader(opts: { gas?: boolean } = {}) {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "5000",
          asset: USDC_BASE,
          payTo: TEST_RECIPIENT,
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2" },
        },
        {
          scheme: "upto",
          network: "eip155:8453",
          amount: "20000",
          asset: USDC_BASE,
          payTo: TEST_RECIPIENT,
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2", facilitatorAddress: FACILITATOR },
        },
      ],
      resource: { url: "https://blockrun.ai/api/v1/chat/completions", description: "chat" },
      extensions: opts.gas ? { eip2612GasSponsoring: { info: {}, schema: {} } } : {},
    }),
  );
}

function word(n: bigint) {
  return "0x" + n.toString(16).padStart(64, "0");
}

/**
 * Route fetch: RPC batches to the mock node; the gateway answers 402 to an
 * unpaid request and `paid` to a paid one. Records every PAYMENT-SIGNATURE.
 */
function mockNetwork(opts: {
  allowance: bigint;
  gas?: boolean;
  /** The gateway's answer to a paid request, given the scheme that was signed. */
  paid: (scheme: string) => Response;
}) {
  const signatures: string[] = [];
  let rpcCalls = 0;
  vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === RPC) {
      rpcCalls++;
      const batch = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify(
          batch.map((c: { id: number; params: [{ data: string }] }) => {
            const sel = c.params[0].data.slice(0, 10);
            const v = sel === "0x70a08231" ? 10n ** 12n : sel === "0xdd62ed3e" ? opts.allowance : 5n;
            return { jsonrpc: "2.0", id: c.id, result: word(v) };
          }),
        ),
      );
    }
    const sig = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
    if (!sig) {
      return new Response("{}", {
        status: 402,
        headers: { "payment-required": paymentRequiredHeader({ gas: opts.gas }) },
      });
    }
    signatures.push(sig);
    return opts.paid(JSON.parse(atob(sig)).accepted.scheme);
  });
  return { signatures, rpcCalls: () => rpcCalls };
}

const settled = (amount?: string) =>
  new Response(JSON.stringify(buildChatResponse()), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-RESPONSE": btoa(
        JSON.stringify({ success: true, transaction: "0xabc", network: "eip155:8453", ...(amount ? { amount } : {}) }),
      ),
    },
  });

const decode = (b64: string) => JSON.parse(atob(b64));

describe("LLMClient x402 upto", () => {
  beforeEach(() => {
    process.env.BASE_RPC_URL = RPC;
    vi.mocked(logCost).mockClear();
  });
  afterEach(() => {
    delete process.env.BASE_RPC_URL;
    delete process.env.BLOCKRUN_PAYMENT_SCHEME;
  });

  it("pays upto and books the SETTLED amount from PAYMENT-RESPONSE", async () => {
    const net = mockNetwork({ allowance: 10n ** 12n, paid: () => settled("1234") });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await client.chat("deepseek/deepseek-chat", "hi");

    expect(net.signatures).toHaveLength(1);
    const payload = decode(net.signatures[0]);
    expect(payload.accepted.scheme).toBe("upto");
    expect(payload.payload.permit2Authorization.permitted.amount).toBe("20000");

    expect(client.getSpending()).toEqual({ totalUsd: 0.001234, calls: 1, uptoCeilingUsd: 0 });
    expect(vi.mocked(logCost)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logCost).mock.calls[0][0]).toMatchObject({
      endpoint: "/api/v1/chat/completions",
      cost_usd: 0.001234,
      model: "deepseek/deepseek-chat",
      network: "eip155:8453",
      scheme: "upto",
      cost_basis: "settled",
    });
  });

  it("books the ceiling, labelled as such, when no settled amount is reported", async () => {
    mockNetwork({ allowance: 10n ** 12n, paid: () => settled() });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await client.chat("deepseek/deepseek-chat", "hi");

    expect(client.getSpending()).toEqual({ totalUsd: 0.02, calls: 1, uptoCeilingUsd: 0.02 });
    expect(vi.mocked(logCost).mock.calls[0][0]).toMatchObject({ cost_usd: 0.02, scheme: "upto", cost_basis: "ceiling" });
  });

  it("a wallet with no Permit2 allowance uses upto via gas sponsoring when the 402 declares it", async () => {
    const net = mockNetwork({ allowance: 0n, gas: true, paid: () => settled("900") });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await client.chat("deepseek/deepseek-chat", "hi");
    const payload = decode(net.signatures[0]);
    expect(payload.accepted.scheme).toBe("upto");
    expect(payload.extensions.eip2612GasSponsoring.info).toMatchObject({ amount: "20000", nonce: "5" });
  });

  it("no allowance and no gas sponsoring → exact, booked exactly as before (no upto labels)", async () => {
    const net = mockNetwork({ allowance: 0n, paid: () => settled() });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await client.chat("deepseek/deepseek-chat", "hi");
    expect(decode(net.signatures[0]).accepted.scheme).toBe("exact");
    expect(client.getSpending()).toEqual({ totalUsd: 0.005, calls: 1, uptoCeilingUsd: 0 });
    const entry = vi.mocked(logCost).mock.calls[0][0];
    expect(entry.cost_usd).toBe(0.005);
    expect(entry).not.toHaveProperty("scheme");
    expect(entry).not.toHaveProperty("cost_basis");
  });

  it("paymentScheme: 'exact' opts out entirely (no RPC)", async () => {
    const net = mockNetwork({ allowance: 10n ** 12n, paid: () => settled("1") });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY, paymentScheme: "exact" });
    await client.chat("deepseek/deepseek-chat", "hi");
    expect(decode(net.signatures[0]).accepted.scheme).toBe("exact");
    expect(net.rpcCalls()).toBe(0);
  });

  it("BLOCKRUN_PAYMENT_SCHEME=exact opts out; the OpenAI wrapper forwards paymentScheme", async () => {
    process.env.BLOCKRUN_PAYMENT_SCHEME = "exact";
    const net = mockNetwork({ allowance: 10n ** 12n, paid: () => settled("1") });
    await new LLMClient({ privateKey: TEST_PRIVATE_KEY }).chat("deepseek/deepseek-chat", "hi");
    delete process.env.BLOCKRUN_PAYMENT_SCHEME;
    const openai = new OpenAI({ walletKey: TEST_PRIVATE_KEY, paymentScheme: "exact" });
    await openai.chat.completions.create({ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }] });
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["exact", "exact"]);
    expect(net.rpcCalls()).toBe(0);
  });

  const rejected402 = () =>
    new Response(JSON.stringify({ error: "Payment verification failed", code: "PAYMENT_INVALID" }), { status: 402 });

  it("upto rejected (402) → exactly one exact retry, which succeeds; upto is then skipped for the client's life", async () => {
    const net = mockNetwork({
      allowance: 10n ** 12n,
      paid: (scheme) => (scheme === "upto" ? rejected402() : settled()),
    });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await client.chat("deepseek/deepseek-chat", "hi");
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["upto", "exact"]);
    // The retry is built from the 402's exact entry (accepts[0]).
    expect(decode(net.signatures[1]).payload.authorization.value).toBe("5000");
    expect(client.getSpending()).toEqual({ totalUsd: 0.005, calls: 1, uptoCeilingUsd: 0 });

    // Remembered per wallet+network: later calls go straight to exact — no RPC, no rejected round trip.
    const rpcBefore = net.rpcCalls();
    await client.chat("deepseek/deepseek-chat", "hi");
    await client.chat("deepseek/deepseek-chat", "hi");
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["upto", "exact", "exact", "exact"]);
    expect(net.rpcCalls()).toBe(rpcBefore);

    // In memory only: a new client tries upto again.
    await new LLMClient({ privateKey: TEST_PRIVATE_KEY }).chat("deepseek/deepseek-chat", "hi");
    expect(decode(net.signatures[4]).accepted.scheme).toBe("upto");
  });

  it("a payment-verification error BODY on a non-402 status also triggers the one exact retry", async () => {
    const net = mockNetwork({
      allowance: 10n ** 12n,
      paid: (scheme) =>
        scheme === "upto"
          ? new Response(JSON.stringify({ error: "Payment verification failed", debug: "permit2" }), { status: 400 })
          : settled(),
    });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await client.chat("deepseek/deepseek-chat", "hi");
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["upto", "exact"]);
  });

  it("a non-payment error after upto (a plain 400) is NOT retried", async () => {
    const net = mockNetwork({
      allowance: 10n ** 12n,
      paid: () => new Response(JSON.stringify({ error: { message: "max_tokens too large" } }), { status: 400 }),
    });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await expect(client.chat("deepseek/deepseek-chat", "hi")).rejects.toMatchObject({ statusCode: 400 });
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["upto"]);
  });

  it("exact retry also rejected → the ORIGINAL upto rejection surfaces, no further retries", async () => {
    const net = mockNetwork({
      allowance: 10n ** 12n,
      paid: (scheme) =>
        scheme === "upto"
          ? new Response(JSON.stringify({ error: "Payment verification failed (upto-original)" }), { status: 400 })
          : rejected402(),
    });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    // The original was a 400 verification body → APIError(400); the exact retry's 402 would have been PaymentError.
    const err = await client.chat("deepseek/deepseek-chat", "hi").catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400 });
    expect(JSON.stringify(err.response)).toContain("upto-original");
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["upto", "exact"]);
    expect(client.getSpending()).toEqual({ totalUsd: 0, calls: 0, uptoCeilingUsd: 0 });
  });

  it("a 2xx is never retried, including a free-model rescue of a failed upto payment (which still disables upto)", async () => {
    const rescue = () =>
      new Response(JSON.stringify(buildChatResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Free-Fallback": "payment-failed", "X-Fallback-Used": "true" },
      });
    const net = mockNetwork({ allowance: 10n ** 12n, paid: (scheme) => (scheme === "upto" ? rescue() : settled()) });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await client.chat("deepseek/deepseek-chat", "hi");
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["upto"]);
    await client.chat("deepseek/deepseek-chat", "hi");
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["upto", "exact"]);
  });

  it("streams: a rejected upto gets one exact retry before any body; a 2xx stream is never retried", async () => {
    const sse = () => new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const net = mockNetwork({ allowance: 10n ** 12n, paid: (scheme) => (scheme === "upto" ? rejected402() : sse()) });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const resp = await client.chatCompletionStream("deepseek/deepseek-chat", [{ role: "user", content: "hi" }]);
    expect(resp.status).toBe(200);
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["upto", "exact"]);
    expect(client.getSpending()).toEqual({ totalUsd: 0.005, calls: 1, uptoCeilingUsd: 0 });

    const ok = mockNetwork({ allowance: 10n ** 12n, paid: () => sse() });
    await new LLMClient({ privateKey: TEST_PRIVATE_KEY }).chatCompletionStream("deepseek/deepseek-chat", [
      { role: "user", content: "hi" },
    ]);
    expect(ok.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["upto"]);
  });

  it("a rejected exact payment still raises PaymentError (no extra retry)", async () => {
    const net = mockNetwork({ allowance: 0n, paid: () => new Response("{}", { status: 402 }) });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await expect(client.chat("deepseek/deepseek-chat", "hi")).rejects.toThrow(/Payment was rejected/);
    expect(net.signatures.map((s) => decode(s).accepted.scheme)).toEqual(["exact"]);
  });

  it("rejects an invalid paymentScheme at construction", () => {
    expect(() => new LLMClient({ privateKey: TEST_PRIVATE_KEY, paymentScheme: "upto" as never })).toThrow(/paymentScheme/);
  });

  it("streams pay upto and book the labelled ceiling (a stream settles after its last byte)", async () => {
    const net = mockNetwork({
      allowance: 10n ** 12n,
      paid: () => new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    });
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await client.chatCompletionStream("deepseek/deepseek-chat", [{ role: "user", content: "hi" }]);
    expect(decode(net.signatures[0]).accepted.scheme).toBe("upto");
    expect(client.getSpending()).toEqual({ totalUsd: 0.02, calls: 1, uptoCeilingUsd: 0.02 });
  });
});
