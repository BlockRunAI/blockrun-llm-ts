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

  // The fixtures above are hand-authored shapes. These are the bodies the LIVE
  // gateway actually returns, copied from the route handlers — the classifier
  // matching nothing real is invisible without them.
  describe("live gateway 402 bodies", () => {
    it("classifies the chat/completions stale rejection", async () => {
      // blockrun src/app/api/v1/chat/completions/route.ts:2138 — the spread is
      // explainVerifyFailure(), which returns PAYMENT_BLOCKHASH_STALE once the
      // facilitator's invalidMessage is folded into verification.error.
      await expect(
        isSafeStaleBlockhashResponse(
          rejection({
            error: "Payment verification failed",
            code: "PAYMENT_BLOCKHASH_STALE",
            message:
              "The payment transaction was signed against a Solana blockhash " +
              "that has since expired. Nothing was charged.",
            debug: "invalid_exact_svm_payload_transaction: Blockhash not found",
            payer: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
          })
        )
      ).resolves.toBe(true);
    });

    it("does NOT classify the pre-fix chat body (no machine-readable signal)", async () => {
      // What the gateway returned before the contract fix: the stale detail
      // exists only in `debug`, which is a passthrough blob, not a contract.
      // Kept as a fixture so a gateway regression that drops the code fails
      // here instead of silently disabling the retry in production.
      await expect(
        isSafeStaleBlockhashResponse(
          rejection({
            error: "Payment verification failed",
            message: "Message @bc1max on Telegram for help.",
            code: "PAYMENT_INVALID",
            debug: "invalid_exact_svm_payload_transaction: Blockhash not found",
          })
        )
      ).resolves.toBe(false);
    });

    it("classifies the raw-route stale rejection", async () => {
      // blockrun src/app/api/v1/search/route.ts and 23 sibling routes now spread
      // verifyFailureFields() into the body, so requestWithPaymentRaw and
      // requestWithPaymentGetRaw get the same code the chat path does. Body
      // copied verbatim from the route output.
      await expect(
        isSafeStaleBlockhashResponse(
          rejection({
            error: "Payment verification failed",
            code: "PAYMENT_BLOCKHASH_STALE",
            message:
              "The payment transaction was signed against a Solana blockhash that has since expired. Nothing was charged. Sign a fresh payment authorization against a current blockhash and send the request again.",
            details: "invalid_exact_svm_payload_transaction: Blockhash not found",
          })
        )
      ).resolves.toBe(true);
    });

    it("does NOT classify a raw-route body that lost its code field", async () => {
      // The pre-fix shape. Kept so a gateway regression that drops
      // verifyFailureFields fails here instead of silently disabling the retry.
      await expect(
        isSafeStaleBlockhashResponse(
          rejection({
            error: "Payment verification failed",
            details: "invalid_exact_svm_payload_transaction: Blockhash not found",
          })
        )
      ).resolves.toBe(false);
    });
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
