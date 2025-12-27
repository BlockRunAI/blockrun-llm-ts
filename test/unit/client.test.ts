import { describe, it, expect, vi, beforeEach } from "vitest";
import { LLMClient } from "../../src/client";
import { APIError, PaymentError } from "../../src/types";
import {
  TEST_PRIVATE_KEY,
  buildChatResponse,
  buildErrorResponse,
  buildModelsResponse,
  buildPaymentRequiredResponse,
} from "../helpers/testHelpers";

describe("LLMClient", () => {
  describe("Constructor", () => {
    it("should create client with valid private key", () => {
      const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
      expect(client).toBeDefined();
      expect(client.getWalletAddress()).toBeTruthy();
      expect(client.getWalletAddress().startsWith("0x")).toBe(true);
    });

    it("should throw on missing private key", () => {
      expect(() => new LLMClient({} as any)).toThrow("Private key required");
    });

    it("should throw on invalid private key format", () => {
      expect(() => new LLMClient({ privateKey: "invalid" as any })).toThrow(
        "must start with 0x"
      );
    });

    it("should throw on short private key", () => {
      expect(() => new LLMClient({ privateKey: "0x123" as any })).toThrow(
        "66 characters"
      );
    });

    it("should use default API URL", () => {
      const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
      // Can't directly test private apiUrl, but can verify it doesn't throw
      expect(client).toBeDefined();
    });

    it("should accept custom API URL", () => {
      const client = new LLMClient({
        privateKey: TEST_PRIVATE_KEY,
        apiUrl: "https://custom.example.com",
      });
      expect(client).toBeDefined();
    });

    it("should validate custom API URL must use HTTPS", () => {
      expect(() =>
        new LLMClient({
          privateKey: TEST_PRIVATE_KEY,
          apiUrl: "http://insecure.com",
        })
      ).toThrow("HTTPS");
    });

    it("should allow localhost HTTP", () => {
      const client = new LLMClient({
        privateKey: TEST_PRIVATE_KEY,
        apiUrl: "http://localhost:3000",
      });
      expect(client).toBeDefined();
    });
  });

  describe("getWalletAddress", () => {
    it("should return valid Ethereum address", () => {
      const client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
      const address = client.getWalletAddress();

      expect(address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
      expect(address.startsWith("0x")).toBe(true);
      expect(address.length).toBe(42);
    });
  });

  describe("listModels", () => {
    let client: LLMClient;
    let fetchSpy: any;

    beforeEach(() => {
      client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    it("should list available models", async () => {
      const mockResponse = buildModelsResponse();
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const models = await client.listModels();

      expect(models).toHaveLength(3);
      expect(models[0].id).toBe("openai/gpt-4o");
      expect(models[0].provider).toBe("openai");
      expect(models[0].inputPrice).toBe(2.5);
    });

    it("should throw APIError on failure", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(client.listModels()).rejects.toThrow(APIError);
    });
  });

  describe("Error sanitization", () => {
    let client: LLMClient;
    let fetchSpy: any;

    beforeEach(() => {
      client = new LLMClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    it("should sanitize error responses", async () => {
      const rawError = buildErrorResponse({
        error: "Invalid model",
        internal_data: "/var/app/secret.ts:123",
      });

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => rawError,
      });

      try {
        await client.listModels();
        fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        const apiError = error as APIError;

        // Should only contain safe fields
        expect(apiError.response).toEqual({
          message: "Invalid model",
          code: undefined,
        });

        // Should NOT contain sensitive fields
        expect(apiError.response).not.toHaveProperty("internal_stack");
        expect(apiError.response).not.toHaveProperty("api_key");
      }
    });
  });
});
