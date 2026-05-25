import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PortraitClient,
  PORTRAIT_ENROLLMENT_PRICE_USD,
} from "../../src/portrait";
import { APIError, PaymentError } from "../../src/types";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

describe("PortraitClient", () => {
  describe("Constructor", () => {
    it("creates a client with a valid private key", () => {
      const client = new PortraitClient({ privateKey: TEST_PRIVATE_KEY });
      expect(client.getWalletAddress()).toBe(
        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
      );
      expect(client.getSpending()).toEqual({ totalUsd: 0, calls: 0 });
    });

    it("throws when no private key is provided", () => {
      const original = process.env.BLOCKRUN_WALLET_KEY;
      delete process.env.BLOCKRUN_WALLET_KEY;
      const originalBase = process.env.BASE_CHAIN_WALLET_KEY;
      delete process.env.BASE_CHAIN_WALLET_KEY;
      try {
        expect(() => new PortraitClient({})).toThrow("Private key required");
      } finally {
        if (original !== undefined) process.env.BLOCKRUN_WALLET_KEY = original;
        if (originalBase !== undefined)
          process.env.BASE_CHAIN_WALLET_KEY = originalBase;
      }
    });
  });

  describe("PORTRAIT_ENROLLMENT_PRICE_USD", () => {
    it("matches the backend's flat enrollment price", () => {
      expect(PORTRAIT_ENROLLMENT_PRICE_USD).toBe(0.01);
    });
  });

  describe("enroll input validation", () => {
    let client: PortraitClient;

    beforeEach(() => {
      client = new PortraitClient({ privateKey: TEST_PRIVATE_KEY });
    });

    it("rejects an empty name", async () => {
      await expect(
        client.enroll({ name: "", imageUrl: "https://example.com/a.jpg" })
      ).rejects.toThrow("1–64 characters");
    });

    it("rejects a name longer than 64 chars", async () => {
      await expect(
        client.enroll({
          name: "x".repeat(65),
          imageUrl: "https://example.com/a.jpg",
        })
      ).rejects.toThrow("1–64 characters");
    });

    it("rejects a non-http(s) image URL", async () => {
      await expect(
        client.enroll({ name: "Spokesperson", imageUrl: "ftp://example.com/a.jpg" })
      ).rejects.toThrow("http(s) URL");
      await expect(
        client.enroll({ name: "Spokesperson", imageUrl: "not-a-url" })
      ).rejects.toThrow("http(s) URL");
    });
  });

  describe("HTTP flow", () => {
    let client: PortraitClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new PortraitClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("POSTs to /v1/portrait/enroll with snake_case body", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          object: "virtual_portrait",
          asset_id: "ta_abc123",
          group_id: "legacy_rf_xyz",
          name: "Spokesperson",
          image_url: "https://example.com/face.jpg",
          created_at: "2030-01-01T00:00:00.000Z",
        }),
      } as Response);

      const res = await client.enroll({
        name: "  Spokesperson  ",
        imageUrl: "  https://example.com/face.jpg  ",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0];
      expect(String(calledUrl)).toBe(
        "https://blockrun.ai/api/v1/portrait/enroll"
      );
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      // name + imageUrl are trimmed; imageUrl maps to image_url
      expect(JSON.parse(String(reqInit.body))).toEqual({
        name: "Spokesperson",
        image_url: "https://example.com/face.jpg",
      });
      expect(res.asset_id).toBe("ta_abc123");
    });

    it("throws APIError on non-402 failures", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ error: "token360 enrollment failed" }),
      } as Response);

      await expect(
        client.enroll({ name: "Spokesperson", imageUrl: "https://example.com/a.jpg" })
      ).rejects.toThrow(APIError);
    });
  });

  describe("402 payment flow", () => {
    let client: PortraitClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new PortraitClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("throws PaymentError on 402 with no payment requirements", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 402,
        headers: new Headers(),
        json: async () => ({}),
      } as unknown as Response);

      await expect(
        client.enroll({ name: "Spokesperson", imageUrl: "https://example.com/a.jpg" })
      ).rejects.toThrow(PaymentError);
    });
  });
});
