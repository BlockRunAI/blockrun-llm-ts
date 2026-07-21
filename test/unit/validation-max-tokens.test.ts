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

  it("accepts everything up to and including the bound", () => {
    // Without these the whole range between today's largest model and the
    // typo case is untested, so lowering the constant back toward 262_144
    // would not fail a single test — which is the bug this file exists for.
    expect(() => validateMaxTokens(999_999)).not.toThrow();
    expect(() => validateMaxTokens(MAX_TOKENS_SANITY_LIMIT)).not.toThrow();
    expect(() => validateMaxTokens(MAX_TOKENS_SANITY_LIMIT + 1)).toThrow(/implausibly large/);
  });

  it("does not describe itself as a model limit", () => {
    // The old message read "maxTokens too large (maximum: 100000)", which is
    // what led a caller to record 100000 as an upstream model ceiling and
    // propagate it into a downstream token table. The text has to make clear
    // the number is the SDK's, not the model's.
    let message = "";
    try {
      validateMaxTokens(1_000_001);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not a model limit/);
    expect(message).toMatch(/sanity limit/);
  });

  it("keeps the bound above every ceiling a real model could plausibly serve", () => {
    // Pin the exact value, not just "> today's largest". A bound of 262_145
    // satisfies `> 262_144` and reintroduces the defect one token higher.
    expect(MAX_TOKENS_SANITY_LIMIT).toBe(1_000_000);
  });

  it("still rejects non-integers and non-positive values", () => {
    expect(() => validateMaxTokens(1.5)).toThrow(/integer/);
    expect(() => validateMaxTokens(0)).toThrow(/positive/);
    expect(() => validateMaxTokens(-1)).toThrow(/positive/);
  });

  it("carries a machine-readable code so consumers need not match on prose", () => {
    // The old failure was a bare Error whose only handle was the string
    // "too large (maximum: 100000)". Changing that text silently broke anyone
    // matching on it, so the error now carries the fields instead.
    try {
      validateMaxTokens(1_000_001);
      expect.unreachable();
    } catch (e) {
      const err = e as Error & { code?: string; limit?: number };
      expect(err.code).toBe("MAX_TOKENS_SANITY_LIMIT");
      expect(err.limit).toBe(MAX_TOKENS_SANITY_LIMIT);
    }
  });
});

describe("maxTokens is validated on the request path", () => {
  // Regression for the defect the guard's own docblock used to misdescribe:
  // no client called validateMaxTokens, so the bound never applied to a real
  // request. These pin the wiring, not just the function.
  const overLimit = MAX_TOKENS_SANITY_LIMIT + 1;
  const key = "0x" + "1".repeat(64);

  it("rejects before any network call in LLMClient.chatCompletion", async () => {
    const { LLMClient } = await import("../../src/client");
    const client = new LLMClient(key as `0x${string}`);
    await expect(
      client.chatCompletion("openai/gpt-5.2", [{ role: "user", content: "hi" }], {
        maxTokens: overLimit,
      })
    ).rejects.toThrow(/implausibly large/);
  });

  it("rejects before any network call in LLMClient.chatCompletionStream", async () => {
    const { LLMClient } = await import("../../src/client");
    const client = new LLMClient(key as `0x${string}`);
    await expect(
      client.chatCompletionStream("openai/gpt-5.2", [{ role: "user", content: "hi" }], {
        maxTokens: overLimit,
      })
    ).rejects.toThrow(/implausibly large/);
  });

  it("accepts a real model ceiling that the old 100000 bound would have rejected", async () => {
    const { LLMClient } = await import("../../src/client");
    const client = new LLMClient(key as `0x${string}`);
    // 262144 must get past validation and fail later (at the network), not here.
    await expect(
      client.chatCompletion("zai/glm-5.2", [{ role: "user", content: "hi" }], {
        maxTokens: 262_144,
      })
    ).rejects.not.toThrow(/implausibly large/);
  });
});
