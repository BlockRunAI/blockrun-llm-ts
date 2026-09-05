// Streaming on Solana: the 402 handshake in front of an SSE body.
//
// This path did not exist until 3.15.0, and its absence was not a missing
// convenience — a streaming caller could not use SolanaLLMClient at all, so
// every agent harness on this SDK was Base-only whatever the docs said.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaLLMClient } from "../../src/solana-client";
import { APIError, PaymentError } from "../../src/types";

const TEST_BS58_KEY =
  "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

/** An SSE response body built from complete frames. */
function sse(...frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join("\n") + "\n"));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

/** An SSE body delivered in arbitrary network-sized pieces. */
function chunkedSse(pieces: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

/** A Solana x402 quote, in the shape the gateway really returns. */
function quote402(amount = "1000"): Response {
  return new Response(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://sol.blockrun.ai/api/v1/chat/completions", description: "chat" },
      accepts: [
        {
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          amount,
          payTo: "AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA",
          maxTimeoutSeconds: 300,
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          extra: { feePayer: "FeePayer1111111111111111111111111111111111" },
        },
      ],
    }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** The gateway's verification-phase stale-blockhash rejection. */
function staleRejection(): Response {
  return new Response(
    JSON.stringify({
      code: "PAYMENT_BLOCKHASH_STALE",
      error: "Payment verification failed",
    }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** Drain a stream into an array. */
async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("SolanaLLMClient.stream", () => {
  let client: SolanaLLMClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses SSE frames and stops at [DONE]", async () => {
    fetchSpy.mockResolvedValueOnce(
      sse(
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        "data: [DONE]"
      )
    );

    const chunks = await drain(
      client.stream<{ choices: { delta: { content: string } }[] }>("/v1/chat/completions", {
        model: "deepseek/deepseek-chat",
        messages: [],
        stream: true,
      })
    );

    expect(chunks.map((c) => c.choices[0].delta.content)).toEqual(["Hello", " world"]);
  });

  it("reassembles a frame split across two network reads", async () => {
    // The failure this prevents is silent: half a JSON object parses as
    // malformed, gets skipped, and the caller loses a token with no error.
    fetchSpy.mockResolvedValueOnce(
      chunkedSse(['data: {"value"', ':42}\ndata: [DONE]\n'])
    );

    expect(await drain(client.stream<{ value: number }>("/v1/chat/completions", {}))).toEqual([
      { value: 42 },
    ]);
  });

  it("skips a malformed frame rather than failing the whole answer", async () => {
    fetchSpy.mockResolvedValueOnce(
      sse('data: {"valid":1}', "data: not json at all", 'data: {"valid":2}', "data: [DONE]")
    );

    expect(await drain(client.stream<{ valid: number }>("/v1/chat/completions", {}))).toEqual([
      { valid: 1 },
      { valid: 2 },
    ]);
  });

  it("settles nothing when the gateway answers 200 without a quote", async () => {
    // The free tier, and API-key mode. Recording a payment here would invent a
    // charge against a wallet that was never touched.
    fetchSpy.mockResolvedValueOnce(sse('data: {"ok":1}', "data: [DONE]"));

    await drain(client.stream("/v1/chat/completions", { model: "nvidia/nemotron-3.5-lightning" }));

    expect(client.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("signs a 402, replays the SAME body, and streams the paid response", async () => {
    const signed = vi
      .spyOn(client as unknown as { signPaymentFrom402: () => unknown }, "signPaymentFrom402")
      .mockResolvedValue({ paymentPayload: "signed-payload", costUsd: 0.001 });

    fetchSpy
      .mockResolvedValueOnce(quote402())
      .mockResolvedValueOnce(sse('data: {"paid":true}', "data: [DONE]"));

    expect(await drain(client.stream<{ paid: boolean }>("/v1/chat/completions", { model: "x" })))
      .toEqual([{ paid: true }]);

    expect(signed).toHaveBeenCalledTimes(1);
    const [, retry] = fetchSpy.mock.calls;
    const init = retry[1] as RequestInit;
    expect((init.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBe("signed-payload");
    // The gateway quoted for THIS body. Replaying a different one would pay for
    // one request and receive another.
    expect(init.body).toBe(JSON.stringify({ model: "x" }));
    expect(client.getSpending()).toEqual({ totalUsd: 0.001, calls: 1 });
  });

  it("re-signs once with a fresh blockhash after a verification-phase stale rejection", async () => {
    const signed = vi
      .spyOn(client as unknown as { signPaymentFrom402: () => unknown }, "signPaymentFrom402")
      .mockResolvedValue({ paymentPayload: "signed-payload", costUsd: 0.001 });

    fetchSpy
      .mockResolvedValueOnce(quote402())
      .mockResolvedValueOnce(staleRejection())
      .mockResolvedValueOnce(quote402())
      .mockResolvedValueOnce(sse('data: {"paid":true}', "data: [DONE]"));

    expect(await drain(client.stream<{ paid: boolean }>("/v1/chat/completions", {}))).toEqual([
      { paid: true },
    ]);

    // Second signature is forced fresh, so the retry cannot be byte-identical
    // to the transaction the gateway just rejected as expired.
    expect(signed.mock.calls.map((call) => call[2])).toEqual([false, true]);
    // One settlement, not two: the first attempt never settled.
    expect(client.getSpending()).toEqual({ totalUsd: 0.001, calls: 1 });
  });

  it("does not re-sign a rejection that could already have settled", async () => {
    // A settlement-phase failure may have moved USDC. Re-signing it pays twice,
    // which is the one mistake this whole classification exists to prevent.
    vi.spyOn(client as unknown as { signPaymentFrom402: () => unknown }, "signPaymentFrom402")
      .mockResolvedValue({ paymentPayload: "signed-payload", costUsd: 0.001 });

    fetchSpy.mockResolvedValueOnce(quote402()).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: "SETTLEMENT_FAILED", reason: "expired_signature" }),
        { status: 402, headers: { "content-type": "application/json" } }
      )
    );

    await expect(drain(client.stream("/v1/chat/completions", {}))).rejects.toThrow(PaymentError);
    expect(client.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
  });

  it("raises a non-402 failure before any frame is yielded", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "nope" }), { status: 400 })
    );

    await expect(drain(client.stream("/v1/chat/completions", {}))).rejects.toThrow(APIError);
  });

  it("tolerates a path written with the website's /api prefix", async () => {
    fetchSpy.mockResolvedValueOnce(sse("data: [DONE]"));

    await drain(client.stream("/api/v1/chat/completions", {}));

    expect(fetchSpy.mock.calls[0][0]).toBe("https://sol.blockrun.ai/api/v1/chat/completions");
  });

  it("sends a bearer token and never a 402 handshake in API-key mode", async () => {
    const keyed = new SolanaLLMClient({ apiKey: "brk_live_test" });
    fetchSpy.mockResolvedValueOnce(sse('data: {"ok":1}', "data: [DONE]"));

    await drain(keyed.stream("/v1/chat/completions", {}));

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.blockrun.ai/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer brk_live_test");
  });
});
