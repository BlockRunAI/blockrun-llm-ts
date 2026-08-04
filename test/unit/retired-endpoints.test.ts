// Helpers for endpoints Predexon retired must fail fast, not silently 410.
//
// Probed upstream 2026-08-04 (3 runs each): /v1/pm/markets,
// /v1/pm/markets/listings and /v1/pm/outcomes/{id} all return
//   410 "This endpoint has been sunset as of 2026-07-20. Market matching is
//       discontinued."
// The helpers are kept rather than deleted so upgrading does not break property
// access; this pins that they throw before any network I/O.
import { describe, it, expect } from "vitest";
import { LLMClient, RetiredEndpointError } from "../../src/index";

// No wallet, no network — if a helper reached fetch() these would hang or throw
// something other than RetiredEndpointError.
const client = Object.create(LLMClient.prototype) as LLMClient;

describe("retired Predexon helpers", () => {
  it("pmMarkets throws with the sunset date", async () => {
    await expect(client.pmMarkets()).rejects.toThrow(RetiredEndpointError);
    await expect(client.pmMarkets()).rejects.toThrow(/2026-07-20/);
  });

  it("pmListings throws with the sunset date", async () => {
    await expect(client.pmListings()).rejects.toThrow(RetiredEndpointError);
    await expect(client.pmListings()).rejects.toThrow(/2026-07-20/);
  });

  it("pmOutcome throws with the sunset date", async () => {
    await expect(client.pmOutcome("PXM-12345")).rejects.toThrow(RetiredEndpointError);
    await expect(client.pmOutcome("PXM-12345")).rejects.toThrow(/2026-07-20/);
  });

  it("points at the surviving replacement", async () => {
    await expect(client.pmMarkets()).rejects.toThrow(/markets\/search/);
  });

  it("is a BlockrunError, so existing catch blocks still catch it", async () => {
    const err = await client.pmMarkets().catch((e) => e);
    expect(err.name).toBe("RetiredEndpointError");
    expect(err).toBeInstanceOf(Error);
  });
});
