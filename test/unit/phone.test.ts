import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PhoneClient, PHONE_PRICES } from "../../src/phone";
import { APIError, PaymentError } from "../../src/types";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

describe("PhoneClient", () => {
  describe("Constructor", () => {
    it("creates a client with a valid private key", () => {
      const client = new PhoneClient({ privateKey: TEST_PRIVATE_KEY });
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
        expect(() => new PhoneClient({})).toThrow("Private key required");
      } finally {
        if (original !== undefined) process.env.BLOCKRUN_WALLET_KEY = original;
        if (originalBase !== undefined)
          process.env.BASE_CHAIN_WALLET_KEY = originalBase;
      }
    });
  });

  describe("PHONE_PRICES", () => {
    it("matches the backend's PHONE_PRICES table", () => {
      expect(PHONE_PRICES).toMatchObject({
        lookup: 0.01,
        "lookup/fraud": 0.05,
        "numbers/buy": 5.0,
        "numbers/renew": 5.0,
        "numbers/list": 0.001,
        "numbers/release": 0.0,
      });
    });
  });

  describe("E.164 validation", () => {
    let client: PhoneClient;

    beforeEach(() => {
      client = new PhoneClient({ privateKey: TEST_PRIVATE_KEY });
    });

    it("rejects an empty phone number on lookup", async () => {
      await expect(client.lookup("")).rejects.toThrow("E.164");
    });

    it("rejects a phone number missing the + prefix", async () => {
      await expect(client.lookup("14155552671")).rejects.toThrow("E.164");
    });

    it("rejects non-digit characters", async () => {
      await expect(client.lookup("+1-415-555-2671")).rejects.toThrow("E.164");
    });

    it("rejects on renewNumber and releaseNumber too", async () => {
      await expect(client.renewNumber("notanumber")).rejects.toThrow("E.164");
      await expect(client.releaseNumber("notanumber")).rejects.toThrow("E.164");
    });
  });

  describe("buyNumber input validation", () => {
    let client: PhoneClient;

    beforeEach(() => {
      client = new PhoneClient({ privateKey: TEST_PRIVATE_KEY });
    });

    it("rejects country codes other than US or CA", async () => {
      await expect(
        client.buyNumber({ country: "MX" as unknown as "US" })
      ).rejects.toThrow("US");
    });

    it("rejects non-3-digit area codes", async () => {
      await expect(client.buyNumber({ areaCode: "41" })).rejects.toThrow(
        "3-digit"
      );
      await expect(client.buyNumber({ areaCode: "4155" })).rejects.toThrow(
        "3-digit"
      );
      await expect(client.buyNumber({ areaCode: "abc" })).rejects.toThrow(
        "3-digit"
      );
    });
  });

  describe("HTTP flow", () => {
    let client: PhoneClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new PhoneClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("POSTs lookup to /v1/phone/lookup with phoneNumber body", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ phone_number: "+14155552671", carrier: null }),
      } as Response);

      const res = await client.lookup("+14155552671");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0];
      expect(String(calledUrl)).toBe("https://blockrun.ai/api/v1/phone/lookup");
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      expect(JSON.parse(String(reqInit.body))).toEqual({
        phoneNumber: "+14155552671",
      });
      expect(res.phone_number).toBe("+14155552671");
    });

    it("hits /v1/phone/numbers/list for listNumbers and parses the response", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          numbers: [
            {
              phone_number: "+14155552671",
              chain: "base",
              expires_at: "2030-01-01T00:00:00.000Z",
              active: true,
            },
          ],
          count: 1,
        }),
      } as Response);

      const res = await client.listNumbers();
      const [calledUrl] = fetchSpy.mock.calls[0];
      expect(String(calledUrl)).toBe(
        "https://blockrun.ai/api/v1/phone/numbers/list"
      );
      expect(res.count).toBe(1);
      expect(res.numbers[0].phone_number).toBe("+14155552671");
    });

    it("forwards areaCode in the buy body when supplied", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          phone_number: "+14155550100",
          expires_at: "2030-01-01T00:00:00.000Z",
          chain: "base",
        }),
      } as Response);

      await client.buyNumber({ country: "US", areaCode: "415" });
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({
        country: "US",
        areaCode: "415",
      });
    });

    it("throws APIError on non-402 failures", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      } as Response);

      await expect(client.lookup("+14155552671")).rejects.toThrow(APIError);
    });
  });

  describe("402 payment flow", () => {
    let client: PhoneClient;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client = new PhoneClient({ privateKey: TEST_PRIVATE_KEY });
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

      await expect(client.lookup("+14155552671")).rejects.toThrow(PaymentError);
    });
  });
});
