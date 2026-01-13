import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImageClient } from "../../src/image";
import { APIError } from "../../src/types";
import {
  TEST_PRIVATE_KEY,
  buildImageModelsResponse,
  buildImageResponse,
} from "../helpers/testHelpers";

describe("ImageClient", () => {
  describe("Constructor", () => {
    it("should create client with valid private key", () => {
      const client = new ImageClient({ privateKey: TEST_PRIVATE_KEY });
      expect(client).toBeDefined();
      expect(client.getWalletAddress()).toBeTruthy();
      expect(client.getWalletAddress().startsWith("0x")).toBe(true);
    });

    it("should throw on missing private key", () => {
      expect(() => new ImageClient({} as any)).toThrow("Private key required");
    });

    it("should throw on invalid private key format", () => {
      expect(() => new ImageClient({ privateKey: "invalid" as any })).toThrow(
        "must start with 0x"
      );
    });

    it("should accept custom API URL", () => {
      const client = new ImageClient({
        privateKey: TEST_PRIVATE_KEY,
        apiUrl: "https://custom.example.com",
      });
      expect(client).toBeDefined();
    });
  });

  describe("getWalletAddress", () => {
    it("should return valid Ethereum address", () => {
      const client = new ImageClient({ privateKey: TEST_PRIVATE_KEY });
      const address = client.getWalletAddress();

      expect(address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
      expect(address.startsWith("0x")).toBe(true);
      expect(address.length).toBe(42);
    });
  });

  describe("getSpending", () => {
    it("should return initial zero spending", () => {
      const client = new ImageClient({ privateKey: TEST_PRIVATE_KEY });
      const spending = client.getSpending();

      expect(spending.totalUsd).toBe(0);
      expect(spending.calls).toBe(0);
    });
  });

  describe("listImageModels", () => {
    let client: ImageClient;
    let fetchSpy: any;

    beforeEach(() => {
      client = new ImageClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    it("should list available image models", async () => {
      const mockResponse = buildImageModelsResponse();
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const models = await client.listImageModels();

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("google/nano-banana");
      expect(models[0].provider).toBe("google");
      expect(models[0].pricePerImage).toBe(0.01);
    });

    it("should throw APIError on failure", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(client.listImageModels()).rejects.toThrow(APIError);
    });
  });
});
