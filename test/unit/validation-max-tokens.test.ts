import { describe, it, expect } from "vitest";
import { validateMaxTokens, MAX_TOKENS_SANITY_LIMIT } from "../../src/validation";

describe("validateMaxTokens", () => {
  it("accepts the ceilings the gateway actually serves", () => {
    // Regression. This bound was 100000, which rejected every ceiling above it
    // *client-side* — the caller got an Error that never reached the network,
    // naming a limit no provider had set. Probed against the live gateway on
    // 2026-07-21 with the guard bypassed: 19 models advertise more than 100000
    // and all 19 accepted their advertised ceiling.
    expect(() => validateMaxTokens(128_000)).not.toThrow(); // opus-4.8, sonnet-5, gpt-5.6, glm-5
    expect(() => validateMaxTokens(262_144)).not.toThrow(); // zai/glm-5.2, the highest served
  });

  it("still catches an obvious mistake", () => {
    // The bound is a typo guard: a byte count, a timestamp, or a stray 1e9
    // should fail locally rather than become a payment quote.
    expect(() => validateMaxTokens(2_000_000)).toThrow(/implausibly large/);
  });

  it("does not describe itself as a model limit", () => {
    // The old message read "maxTokens too large (maximum: 100000)", which is
    // what led a caller to record 100000 as an upstream model ceiling and
    // propagate it into a downstream token table. The text has to make clear
    // the number is the SDK's, not the model's.
    let message = "";
    try {
      validateMaxTokens(MAX_TOKENS_SANITY_LIMIT + 1);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not a model limit/);
    expect(message).toMatch(/sanity limit/);
  });

  it("keeps the bound above every ceiling a real model could plausibly serve", () => {
    expect(MAX_TOKENS_SANITY_LIMIT).toBeGreaterThan(262_144);
  });

  it("still rejects non-integers and non-positive values", () => {
    expect(() => validateMaxTokens(1.5)).toThrow(/integer/);
    expect(() => validateMaxTokens(0)).toThrow(/positive/);
    expect(() => validateMaxTokens(-1)).toThrow(/positive/);
  });
});
