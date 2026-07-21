import { describe, it, expect, vi } from "vitest";
import { validateMaxTokens } from "../../src/validation";

describe("validateMaxTokens", () => {
  // The SDK mirrors the gateway's contract for max_tokens and nothing more.
  // That contract is `z.number().int().min(1).optional()` in
  // src/app/api/v1/chat/completions/route.ts — integer, at least 1, no ceiling.

  it("rejects exactly what the gateway's schema rejects", () => {
    expect(() => validateMaxTokens(1.5)).toThrow(/integer/);
    expect(() => validateMaxTokens(0)).toThrow(/positive/);
    expect(() => validateMaxTokens(-1)).toThrow(/positive/);
  });

  it("treats an omitted maxTokens as valid", () => {
    // `.optional()` on the gateway side — the caller gets the model-aware
    // default there, so the SDK must not invent one or reject the absence.
    expect(() => validateMaxTokens(undefined)).not.toThrow();
  });

  it("imposes no ceiling of its own", () => {
    // Regression, and the reason this file exists. A client-side ceiling here
    // could only ever reject a request the gateway would have accepted: it
    // clamps with min(requested, model.maxOutput, contextHeadroom) and quotes a
    // fraction of the clamped value, so 1e9 and 1_000_000 price identically.
    // A previous version capped at 100000 and then at 1_000_000, the latter
    // justified in a comment as stopping a typo from "becoming a payment
    // quote" — which was never true and was never checked against the route.
    expect(() => validateMaxTokens(128_000)).not.toThrow();
    expect(() => validateMaxTokens(262_144)).not.toThrow();
    expect(() => validateMaxTokens(1_000_000)).not.toThrow();
    expect(() => validateMaxTokens(1_000_000_000)).not.toThrow();
    expect(() => validateMaxTokens(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
});

describe("maxTokens on the request path", () => {
  const TEST_PRIVATE_KEY = ("0x" + "1".repeat(64)) as `0x${string}`;

  it("rejects a non-integer before any network call", async () => {
    const { LLMClient } = await import("../../src/client");
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    await expect(
      client.chatCompletion("openai/gpt-5.2", [{ role: "user", content: "hi" }], {
        maxTokens: 1.5,
      })
    ).rejects.toThrow(/integer/);
  });

  it("sends an oversized maxTokens to the gateway instead of rejecting it", async () => {
    // The gateway owns the ceiling. Assert the request actually went out
    // carrying the caller's number, rather than dying client-side — stubbed so
    // this never touches the live gateway.
    const { LLMClient } = await import("../../src/client");
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("upstream stub", { status: 500 }));

    try {
      await client
        .chatCompletion("zai/glm-5.2", [{ role: "user", content: "hi" }], {
          maxTokens: 1_000_000,
        })
        .catch(() => undefined);

      expect(fetchSpy).toHaveBeenCalled();
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.max_tokens).toBe(1_000_000);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
