import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/client";
import { SolanaLLMClient } from "../../src/solana-client";
import {
  estimateChatCostUsd,
  platformFeePercentOf,
  routeWithCatalog,
  type ModelPricing,
} from "../../src/router-adapter";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

// Spec: BlockRunAI/blockrun specs/2026-11-16-chat-platform-fee.md PF-8.
// The value is read from the catalog, never typed into the SDK; these tests
// use arbitrary fee values so they stay correct when the gateway's fee moves.

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

describe("platformFeePercentOf", () => {
  it("is 0 when the gateway does not publish the fee (older gateways, enterprise PF-9)", () => {
    expect(platformFeePercentOf({ billing_mode: "paid", pricing: { input: 1, output: 2 } } as never)).toBe(0);
    expect(platformFeePercentOf({})).toBe(0);
    expect(platformFeePercentOf(undefined)).toBe(0);
    expect(platformFeePercentOf(null)).toBe(0);
  });

  it("prefers pricing.platform_fee_percent over the top-level field", () => {
    expect(
      platformFeePercentOf({ billing_mode: "paid", platform_fee_percent: 3, pricing: { platform_fee_percent: 7 } }),
    ).toBe(7);
  });

  it("falls back to the row's top-level platform_fee_percent", () => {
    expect(platformFeePercentOf({ billing_mode: "paid", platform_fee_percent: 4, pricing: {} })).toBe(4);
    expect(platformFeePercentOf({ billing_mode: "paid", platform_fee_percent: 4 })).toBe(4);
  });

  it("reads sol's nested-only shape", () => {
    expect(platformFeePercentOf({ billing_mode: "paid", pricing: { platform_fee_percent: 6 } })).toBe(6);
  });

  it("reads the SDK-mapped camelCase field", () => {
    expect(platformFeePercentOf({ billingMode: "paid", platformFeePercent: 2 })).toBe(2);
  });

  it("skips malformed values (negative, NaN, non-number) and defaults to 0", () => {
    expect(
      platformFeePercentOf({ billing_mode: "paid", platform_fee_percent: 4, pricing: { platform_fee_percent: -1 } }),
    ).toBe(4);
    expect(platformFeePercentOf({ billing_mode: "paid", pricing: { platform_fee_percent: Number.NaN } })).toBe(0);
    expect(platformFeePercentOf({ billing_mode: "paid", pricing: { platform_fee_percent: "5" } })).toBe(0);
    expect(platformFeePercentOf({ billing_mode: "paid", platform_fee_percent: Infinity })).toBe(0);
  });

  it("is 0 for free, flat and media rows even if a fee is present", () => {
    expect(platformFeePercentOf({ billing_mode: "free", platform_fee_percent: 5, pricing: { platform_fee_percent: 5 } })).toBe(0);
    expect(platformFeePercentOf({ billing_mode: "flat", pricing: { flat: 0.01, platform_fee_percent: 5 } as never })).toBe(0);
    expect(platformFeePercentOf({ pricing: { flat: 0.01, platform_fee_percent: 5 } as never })).toBe(0);
    for (const mode of ["per_image", "per_second", "per_character", "per_track", "per_generation", "per_token"]) {
      expect(platformFeePercentOf({ billing_mode: mode, platform_fee_percent: 5, pricing: { platform_fee_percent: 5 } }), mode).toBe(0);
    }
  });
});

describe("estimateChatCostUsd", () => {
  it("multiplies the per-token cost by (1 + fee / 100)", () => {
    const raw = (1000 / 1e6) * 2 + (500 / 1e6) * 10;
    expect(estimateChatCostUsd({ inputPrice: 2, outputPrice: 10, platformFeePercent: 5 }, 1000, 500)).toBeCloseTo(raw * 1.05, 12);
    expect(estimateChatCostUsd({ inputPrice: 2, outputPrice: 10, platformFeePercent: 12.5 }, 1000, 500)).toBeCloseTo(raw * 1.125, 12);
  });

  it("is the list cost when the entry carries no fee", () => {
    expect(estimateChatCostUsd({ inputPrice: 2, outputPrice: 10 }, 1000, 500)).toBeCloseTo((1000 / 1e6) * 2 + (500 / 1e6) * 10, 12);
  });

  it("returns a flat price as-is, with no fee", () => {
    expect(estimateChatCostUsd({ inputPrice: 0, outputPrice: 0, flatPrice: 0.01, platformFeePercent: 5 }, 1e6, 1e6)).toBe(0.01);
  });

  it("free entries stay at $0", () => {
    expect(estimateChatCostUsd({ inputPrice: 0, outputPrice: 0, platformFeePercent: 5 }, 1e6, 1e6)).toBe(0);
  });
});

describe("routeWithCatalog cost metadata", () => {
  function catalog(fee?: number): Map<string, ModelPricing> {
    const rows: Array<[string, number, number]> = [
      ["openai/gpt-5.3-codex", 1.75, 14],
      ["anthropic/claude-sonnet-5", 3, 15],
      ["openai/gpt-5-mini", 0.25, 2],
      ["google/gemini-3.5-flash", 0.5, 3],
      ["moonshot/kimi-k3", 3, 15],
      ["moonshot/kimi-k2.7", 0.5, 2],
      ["deepseek/deepseek-v4-pro", 0.435, 0.87],
      ["deepseek/deepseek-chat", 0.2, 0.4],
      ["google/gemini-2.5-flash", 0.3, 2.5],
      ["anthropic/claude-opus-4.8", 5, 25],
      ["anthropic/claude-opus-4.7", 5, 25],
    ];
    return new Map(
      rows.map(([id, inputPrice, outputPrice]) => [
        id,
        fee === undefined ? { inputPrice, outputPrice } : { inputPrice, outputPrice, platformFeePercent: fee },
      ]),
    );
  }

  const prompt = "Inspect the TypeScript repository, debug the failing tests, edit the files, and verify the fix.";
  const maxOut = 200_000;

  it("prices a catalog model at list x (1 + fee / 100), not router-core's internal margin", () => {
    const withFee = routeWithCatalog(prompt, undefined, maxOut, catalog(5), { minimumPaymentUsd: 0 });
    const noFee = routeWithCatalog(prompt, undefined, maxOut, catalog(), { minimumPaymentUsd: 0 });
    expect(withFee.model).toBe(noFee.model);
    const entry = catalog().get(withFee.model);
    expect(entry, "routed model must be catalog-priced for this test").toBeDefined();
    const inputTokens = Math.ceil(` ${prompt}`.length / 4);
    const list = (inputTokens / 1e6) * entry!.inputPrice + (maxOut / 1e6) * entry!.outputPrice;
    expect(noFee.costEstimate).toBeCloseTo(list, 12);
    expect(withFee.costEstimate).toBeCloseTo(list * 1.05, 12);
  });

  it("still floors a small paid estimate at the payment minimum", () => {
    const decision = routeWithCatalog("Hello", undefined, 8, catalog(5), { minimumPaymentUsd: 0.002 });
    expect(decision.costEstimate).toBe(0.002);
  });

  it("charges no fee on a flat row (router-core's internal margin no longer applies to it)", () => {
    const first = routeWithCatalog(prompt, undefined, maxOut, catalog(5), { minimumPaymentUsd: 0 });
    const pricing = catalog(5);
    pricing.set(first.model, { inputPrice: 0, outputPrice: 0, flatPrice: 0.05, platformFeePercent: 5 });
    const decision = routeWithCatalog(prompt, undefined, maxOut, pricing, { minimumPaymentUsd: 0 });
    expect(decision.model).toBe(first.model);
    expect(decision.costEstimate).toBe(0.05);
  });

  it("keeps a free model at $0", () => {
    const pricing = catalog(5);
    pricing.set("nvidia/nemotron-3.5-lightning", { inputPrice: 0, outputPrice: 0 });
    const decision = routeWithCatalog("Name the capital of France. One word.", undefined, 50, pricing, {
      routingProfile: "eco",
    });
    expect(decision.model).toBe("nvidia/nemotron-3.5-lightning");
    expect(decision.costEstimate).toBe(0);
  });
});

describe("catalog parsing carries the fee into the routing pricing map", () => {
  afterEach(() => vi.restoreAllMocks());

  // One row per shape the gateways serve: base (both places), sol (nested
  // only), an older gateway / enterprise (neither), free, flat and media.
  const rows = [
    { id: "a/base", billing_mode: "paid", platform_fee_percent: 5, pricing: { input: 1, output: 2, platform_fee_percent: 5 }, categories: ["chat"] },
    { id: "a/sol", billing_mode: "paid", pricing: { input: 1, output: 2, platform_fee_percent: 6 }, categories: ["chat"] },
    { id: "a/top", billing_mode: "paid", platform_fee_percent: 4, pricing: { input: 1, output: 2 }, categories: ["chat"] },
    { id: "a/old", billing_mode: "paid", pricing: { input: 1, output: 2 }, categories: ["chat"] },
    { id: "a/free", billing_mode: "free", platform_fee_percent: 0, pricing: { input: 0, output: 0 }, categories: ["chat"] },
    { id: "a/flat", billing_mode: "flat", pricing: { flat: 0.01 }, categories: ["chat"] },
    { id: "a/image", billing_mode: "per_image", pricing: { per_image: 0.04 }, categories: ["image"] },
  ];

  function mockCatalog() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ object: "list", data: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  function expectFees(pricing: Map<string, ModelPricing>) {
    expect(pricing.get("a/base")?.platformFeePercent).toBe(5);
    expect(pricing.get("a/sol")?.platformFeePercent).toBe(6);
    expect(pricing.get("a/top")?.platformFeePercent).toBe(4);
    expect(pricing.get("a/old")?.platformFeePercent).toBeUndefined();
    expect(pricing.get("a/free")?.platformFeePercent).toBeUndefined();
    expect(pricing.get("a/flat")).toEqual({ inputPrice: 0, outputPrice: 0, flatPrice: 0.01 });
    expect(pricing.get("a/image")?.platformFeePercent).toBeUndefined();
  }

  it("LLMClient (Base)", async () => {
    mockCatalog();
    const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
    const pricing = await (client as unknown as { getModelPricing(): Promise<Map<string, ModelPricing>> }).getModelPricing();
    expectFees(pricing);

    const models = await client.listModels();
    expect(models.find((m) => m.id === "a/base")?.platformFeePercent).toBe(5);
    expect(models.find((m) => m.id === "a/old")?.platformFeePercent).toBe(0);
    expect(models.find((m) => m.id === "a/flat")?.platformFeePercent).toBe(0);
  });

  it("SolanaLLMClient", async () => {
    mockCatalog();
    const client = new SolanaLLMClient({ privateKey: TEST_BS58_KEY });
    const pricing = await (client as unknown as { getModelPricing(): Promise<Map<string, ModelPricing>> }).getModelPricing();
    expectFees(pricing);
  });
});
