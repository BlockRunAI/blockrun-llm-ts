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
      // listImageModels now reads the unified /v1/models catalog and
      // filters rows tagged categories: ["image"]. The fixture exposes
      // image rows only — same observable shape post-deprecation.
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

  describe("edit", () => {
    let client: ImageClient;
    let fetchSpy: any;
    const DATA_URI =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    beforeEach(() => {
      client = new ImageClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    it("sends a single image string unchanged in the request body", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => buildImageResponse(),
      });

      await client.edit("Make it a painting", DATA_URI, {
        model: "openai/gpt-image-1",
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sentBody.image).toBe(DATA_URI);
      expect(sentBody.model).toBe("openai/gpt-image-1");
    });

    it("defaults to gpt-image-2 when no model is given", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => buildImageResponse(),
      });

      await client.edit("Make it a painting", DATA_URI);

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sentBody.model).toBe("openai/gpt-image-2");
    });

    it("passes a multi-image array through for fusion", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => buildImageResponse(),
      });

      await client.edit("Place the logo on the shirt", [DATA_URI, DATA_URI], {
        model: "google/nano-banana",
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(Array.isArray(sentBody.image)).toBe(true);
      expect(sentBody.image).toHaveLength(2);
      expect(sentBody.model).toBe("google/nano-banana");
    });
  });
});
