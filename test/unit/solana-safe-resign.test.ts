import { describe, expect, it } from "vitest";
import { isSafeStaleBlockhashResponse } from "../../src/solana-client";

function rejection(body: Record<string, unknown>, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Solana safe stale-blockhash re-sign classification", () => {
  it.each([
    {
      code: "PAYMENT_INVALID",
      reason: "expired_signature",
      error: "Payment verification failed",
    },
    {
      code: "PAYMENT_INVALID",
      invalidMessage: "BlockhashNotFound",
      error: { message: "Payment verification failed" },
    },
    {
      code: "PAYMENT_BLOCKHASH_STALE",
      error: "Payment verification failed",
    },
  ])("accepts an explicit verification-phase stale signal", async (body) => {
    await expect(isSafeStaleBlockhashResponse(rejection(body))).resolves.toBe(true);
  });

  it.each([
    { code: "PAYMENT_BLOCKHASH_STALE" },
    { invalidMessage: "BlockhashNotFound" },
    { debug: "transaction_simulation_failed" },
    {
      code: "SETTLEMENT_FAILED",
      reason: "expired_signature",
      error: "Payment settlement failed",
    },
    {
      code: "PAYMENT_BLOCKHASH_STALE",
      invalidMessage: "BlockhashNotFound",
      error: { message: "Payment settlement failed" },
    },
    {
      code: "PAYMENT_INVALID",
      reason: "insufficient_funds",
      error: "Payment verification failed",
    },
  ])("rejects settlement, terminal, and phase-ambiguous signals", async (body) => {
    await expect(isSafeStaleBlockhashResponse(rejection(body))).resolves.toBe(false);
  });

  it("rejects oversized or malformed failure bodies", async () => {
    await expect(
      isSafeStaleBlockhashResponse(
        new Response("{}", { status: 402, headers: { "content-length": "70000" } })
      )
    ).resolves.toBe(false);
    await expect(
      isSafeStaleBlockhashResponse(new Response("not json", { status: 402 }))
    ).resolves.toBe(false);
    await expect(
      isSafeStaleBlockhashResponse(
        new Response("x".repeat(70_000), { status: 402 })
      )
    ).resolves.toBe(false);
  });
});
