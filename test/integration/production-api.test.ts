/**
 * Integration tests for BlockRun LLM SDK against production API.
 *
 * Requirements:
 * - BLOCKRUN_WALLET_KEY environment variable with funded Base wallet
 * - Minimum $1 USDC on Base chain
 * - Estimated cost per test run: ~$0.05
 *
 * Run with: npm test -- test/integration
 * Skip if no wallet: Tests will be skipped if BLOCKRUN_WALLET_KEY not set
 */

import { describe, it, expect, beforeAll } from "vitest";
import { LLMClient } from "../../src/client";

const WALLET_KEY = process.env.BLOCKRUN_WALLET_KEY;
const PRODUCTION_API = "https://api.blockrun.ai";

// Skip all tests if no wallet key configured
const describeIf = WALLET_KEY ? describe : describe.skip;

describeIf("Production API Integration", () => {
  let client: LLMClient;

  beforeAll(() => {
    if (!WALLET_KEY) {
      console.warn("⚠️  Skipping integration tests: BLOCKRUN_WALLET_KEY not set");
      return;
    }

    client = new LLMClient({
      privateKey: WALLET_KEY as `0x${string}`,
      apiUrl: PRODUCTION_API,
    });

    console.log("\n🧪 Running integration tests against production API");
    console.log(`   Wallet: ${client.getWalletAddress()}`);
    console.log(`   API: ${PRODUCTION_API}`);
    console.log(`   Estimated cost: ~$0.05\n`);
  });

  it("should list available models from production API", async () => {
    const models = await client.listModels();

    expect(models).toBeDefined();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    // Verify model structure
    const firstModel = models[0];
    expect(firstModel).toHaveProperty("id");
    expect(firstModel).toHaveProperty("provider");
    expect(firstModel).toHaveProperty("inputPrice");
    expect(firstModel).toHaveProperty("outputPrice");

    console.log(`   ✓ Found ${models.length} models`);

    // Add delay to respect rate limits
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 30000); // 30 second timeout

  it("should complete a simple chat request", async () => {
    // Use cheapest model for testing
    const response = await client.chat("gemini-2.0-flash-exp", [
      {
        role: "user",
        content: "Say 'test passed' and nothing else",
      },
    ]);

    expect(response).toBeDefined();
    expect(typeof response).toBe("string");
    expect(response.toLowerCase()).toContain("test passed");

    console.log(`   ✓ Chat response: ${response.substring(0, 50)}...`);

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 30000);

  it("should return chat completion with usage stats", async () => {
    const completion = await client.chatCompletion(
      "gemini-2.0-flash-exp",
      [
        {
          role: "user",
          content: "Count to 5",
        },
      ],
      { max_tokens: 50 }
    );

    expect(completion).toBeDefined();
    expect(completion.choices).toBeDefined();
    expect(completion.choices.length).toBeGreaterThan(0);
    expect(completion.choices[0].message).toBeDefined();
    expect(completion.choices[0].message.content).toBeTruthy();

    // Verify usage stats
    expect(completion.usage).toBeDefined();
    expect(completion.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(completion.usage?.completion_tokens).toBeGreaterThan(0);
    expect(completion.usage?.total_tokens).toBeGreaterThan(0);

    console.log(`   ✓ Completion with usage: ${JSON.stringify(completion.usage)}`);

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 30000);

  it("should handle 402 payment flow end-to-end", async () => {
    // This test verifies the full x402 payment protocol:
    // 1. Request to API
    // 2. Receive 402 with payment required
    // 3. Create payment payload with EIP-712 signature
    // 4. Retry with payment receipt
    // 5. Receive successful response

    const response = await client.chat("gemini-2.0-flash-exp", [
      {
        role: "user",
        content: "What is 2+2?",
      },
    ]);

    // If we got a response, the payment flow succeeded
    expect(response).toBeDefined();
    expect(typeof response).toBe("string");
    expect(response).toBeTruthy();

    console.log(`   ✓ Payment flow successful, response received`);

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 30000);

});

// Streaming tests - Coming Soon
// describe.skip("Production API Streaming", () => {
//   it("should handle streaming chat completion", async () => {
//     // Streaming support is planned for a future release
//   });
// });

describeIf("Production API Error Handling", () => {
  let client: LLMClient;

  beforeAll(() => {
    if (!WALLET_KEY) return;

    client = new LLMClient({
      privateKey: WALLET_KEY as `0x${string}`,
      apiUrl: PRODUCTION_API,
    });
  });

  it("should handle invalid model error gracefully", async () => {
    await expect(
      client.chat("invalid-model-that-does-not-exist", [
        {
          role: "user",
          content: "test",
        },
      ])
    ).rejects.toThrow();

    console.log(`   ✓ Invalid model error handled correctly`);

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 30000);

  it("should sanitize error responses", async () => {
    try {
      await client.chat("invalid-model", [
        {
          role: "user",
          content: "test",
        },
      ]);
      expect.fail("Should have thrown an error");
    } catch (error: any) {
      // Error should be sanitized (no internal stack traces, API keys, etc.)
      expect(error.message).toBeDefined();
      expect(error.message).not.toContain("/var/");
      expect(error.message).not.toContain("internal");
      expect(error.message).not.toContain("stack");

      console.log(`   ✓ Error response properly sanitized`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 30000);
});
