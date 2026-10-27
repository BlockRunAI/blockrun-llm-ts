// SolanaLLMClient used a fixed 60 s default while LLMClient used 600 s with a
// BLOCKRUN_CHAT_TIMEOUT override (issue #93): a reasoning model's long turn
// was aborted at 60 s and its batch payment left unresolved. Both clients now
// resolve the same default.
import { afterEach, describe, expect, it, vi } from "vitest";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

async function freshTimeouts(env?: string): Promise<{ solana: number; evm: number }> {
  vi.resetModules();
  if (env === undefined) vi.stubEnv("BLOCKRUN_CHAT_TIMEOUT", undefined as unknown as string);
  else vi.stubEnv("BLOCKRUN_CHAT_TIMEOUT", env);
  const { SolanaLLMClient } = await import("../../src/solana-client");
  const { LLMClient } = await import("../../src/client");
  const solana = new SolanaLLMClient({ privateKey: TEST_BS58_KEY }) as unknown as { timeout: number };
  const evm = new LLMClient({ privateKey: `0x${"11".repeat(32)}` }) as unknown as { timeout: number };
  return { solana: solana.timeout, evm: evm.timeout };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("SolanaLLMClient default timeout", () => {
  it("is 600 s, the same as LLMClient", async () => {
    expect(await freshTimeouts()).toEqual({ solana: 600_000, evm: 600_000 });
  });

  it("honours BLOCKRUN_CHAT_TIMEOUT (seconds) like LLMClient", async () => {
    expect(await freshTimeouts("900")).toEqual({ solana: 900_000, evm: 900_000 });
  });

  it("ignores an invalid BLOCKRUN_CHAT_TIMEOUT", async () => {
    expect(await freshTimeouts("soon")).toEqual({ solana: 600_000, evm: 600_000 });
  });

  it("keeps an explicit timeout option", async () => {
    const { SolanaLLMClient } = await import("../../src/solana-client");
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY, timeout: 45_000 }) as unknown as { timeout: number };
    expect(client.timeout).toBe(45_000);
  });
});
