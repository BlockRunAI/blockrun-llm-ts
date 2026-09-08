import { describe, it, expect } from "vitest";
import { sanitizeErrorResponse } from "../../src/validation.js";

/**
 * A sanitized error must still say what went wrong — and whether money moved.
 *
 * The sanitizer kept only `error` and `code`, so a BlockRun gateway 502 was
 * reduced to "Upstream provider error". The field it dropped, `message`, is the
 * one carrying both the cause and the settlement status:
 *
 *   "Predexon 500: An unexpected error occurred (payment NOT charged)"
 *
 * The caller therefore saw `API error after payment: 502` with no cause and no
 * payment status — while "after payment" asserts a charge the gateway had just
 * said did not happen. Reported as blockrun-mcp#132, where the wallet balance
 * was unchanged and the tool still reported a post-payment failure.
 *
 * The line this draws: `message` and `hint` are gateway-authored operator text,
 * the same strings an unauthenticated caller already gets back, so surfacing
 * them exposes nothing new. Upstream payloads, `details` and `endpoint` stay
 * dropped.
 */
describe("sanitizeErrorResponse", () => {
  const gateway502 = {
    error: "Upstream provider error",
    message: "Predexon 500: An unexpected error occurred (payment NOT charged)",
    status: 500,
    endpoint: "/api/v1/pm/sports/categories",
    method: "GET",
    details: { error: "Internal Server Error", message: "An unexpected error occurred" },
  };

  it("keeps the cause and the payment status", () => {
    const out = sanitizeErrorResponse(gateway502) as Record<string, unknown>;
    expect(out.message).toBe("Upstream provider error");
    expect(out.detail).toContain("payment NOT charged");
    expect(out.detail).toContain("Predexon 500");
  });

  it("still drops everything that is not gateway operator text", () => {
    const out = sanitizeErrorResponse(gateway502) as Record<string, unknown>;
    expect(out).not.toHaveProperty("details");
    expect(out).not.toHaveProperty("endpoint");
    expect(out).not.toHaveProperty("status");
    expect(out).not.toHaveProperty("method");
  });

  it("keeps a hint when the gateway sends one", () => {
    const out = sanitizeErrorResponse({
      error: "Missing parameters",
      hint: "Pass ?symbol=BTC",
    }) as Record<string, unknown>;
    expect(out.hint).toBe("Pass ?symbol=BTC");
  });

  it("does not repeat the same string twice", () => {
    const out = sanitizeErrorResponse({ error: "Bad request", message: "Bad request" }) as Record<
      string,
      unknown
    >;
    expect(out.message).toBe("Bad request");
    expect(out).not.toHaveProperty("detail");
  });

  it("is unchanged for a non-object body", () => {
    expect(sanitizeErrorResponse("boom")).toEqual({ message: "API request failed" });
    expect(sanitizeErrorResponse(null)).toEqual({ message: "API request failed" });
  });

  it("falls back when the body has no error string", () => {
    const out = sanitizeErrorResponse({ foo: "bar" }) as Record<string, unknown>;
    expect(out.message).toBe("API request failed");
  });
});
