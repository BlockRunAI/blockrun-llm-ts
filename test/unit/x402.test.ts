import { describe, it, expect } from "vitest";
import {
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from "../../src/x402";
import { TEST_PRIVATE_KEY, TEST_ACCOUNT, TEST_RECIPIENT } from "../helpers/testHelpers";

describe("x402 Payment Protocol", () => {
  describe("createPaymentPayload", () => {
    it("should create valid payment payload", async () => {
      const payload = await createPaymentPayload(
        TEST_PRIVATE_KEY,
        TEST_ACCOUNT.address,
        TEST_RECIPIENT,
        "1000000",
        "eip155:8453"
      );

      expect(payload).toBeTruthy();
      expect(typeof payload).toBe("string");

      // Should be base64
      expect(() => atob(payload)).not.toThrow();

      // Decode and check structure
      const decoded = JSON.parse(atob(payload));
      expect(decoded.x402Version).toBe(2);
      expect(decoded.payload.signature).toBeTruthy();
      expect(decoded.payload.signature.startsWith("0x")).toBe(true);
      expect(decoded.payload.authorization).toBeTruthy();
      expect(decoded.payload.authorization.from).toBe(TEST_ACCOUNT.address);
      expect(decoded.payload.authorization.to).toBe(TEST_RECIPIENT);
    });

    it("should include resource info when provided", async () => {
      const payload = await createPaymentPayload(
        TEST_PRIVATE_KEY,
        TEST_ACCOUNT.address,
        TEST_RECIPIENT,
        "1000000",
        "eip155:8453",
        {
          resourceUrl: "https://api.blockrun.ai/v1/test",
          resourceDescription: "Test Resource",
        }
      );

      const decoded = JSON.parse(atob(payload));
      expect(decoded.resource.url).toBe("https://api.blockrun.ai/v1/test");
      expect(decoded.resource.description).toBe("Test Resource");
    });

    it("should set valid time windows", async () => {
      const before = Math.floor(Date.now() / 1000);

      const payload = await createPaymentPayload(
        TEST_PRIVATE_KEY,
        TEST_ACCOUNT.address,
        TEST_RECIPIENT,
        "1000000",
        "eip155:8453"
      );

      const after = Math.floor(Date.now() / 1000);
      const decoded = JSON.parse(atob(payload));
      const auth = decoded.payload.authorization;

      // Valid after should be in the past (allows clock skew)
      expect(parseInt(auth.validAfter)).toBeLessThan(before);

      // Valid before should be in the future
      expect(parseInt(auth.validBefore)).toBeGreaterThan(after);
    });

    it("should include accepted payment details", async () => {
      const payload = await createPaymentPayload(
        TEST_PRIVATE_KEY,
        TEST_ACCOUNT.address,
        TEST_RECIPIENT,
        "5000000",
        "eip155:8453"
      );

      const decoded = JSON.parse(atob(payload));
      expect(decoded.accepted.scheme).toBe("exact");
      expect(decoded.accepted.network).toBe("eip155:8453");
      expect(decoded.accepted.amount).toBe("5000000");
      expect(decoded.accepted.payTo).toBe(TEST_RECIPIENT);
    });

    it("should use custom max timeout", async () => {
      const payload = await createPaymentPayload(
        TEST_PRIVATE_KEY,
        TEST_ACCOUNT.address,
        TEST_RECIPIENT,
        "1000000",
        "eip155:8453",
        { maxTimeoutSeconds: 600 }
      );

      const decoded = JSON.parse(atob(payload));
      expect(decoded.accepted.maxTimeoutSeconds).toBe(600);
    });
  });

  describe("parsePaymentRequired", () => {
    it("should parse valid payment required header", () => {
      const data = {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "1000000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: TEST_RECIPIENT,
            maxTimeoutSeconds: 300,
          },
        ],
      };

      const encoded = btoa(JSON.stringify(data));
      const result = parsePaymentRequired(encoded);

      expect(result.x402Version).toBe(2);
      expect(result.accepts).toHaveLength(1);
      expect(result.accepts[0].scheme).toBe("exact");
    });

    it("should throw on invalid base64", () => {
      expect(() => parsePaymentRequired("invalid!!!")).toThrow(
        "invalid format"
      );
    });

    it("should throw on invalid JSON", () => {
      expect(() => parsePaymentRequired(btoa("not json"))).toThrow(
        "invalid format"
      );
    });

    it("should throw on missing accepts field", () => {
      const data = { x402Version: 2 };
      expect(() => parsePaymentRequired(btoa(JSON.stringify(data)))).toThrow(
        "Invalid payment required structure"
      );
    });

    it("should throw on invalid accepts field", () => {
      const data = { x402Version: 2, accepts: "not an array" };
      expect(() => parsePaymentRequired(btoa(JSON.stringify(data)))).toThrow(
        "Invalid payment required structure"
      );
    });
  });

  describe("extractPaymentDetails", () => {
    it("should extract payment details", () => {
      const paymentRequired = {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "1000000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: TEST_RECIPIENT,
            maxTimeoutSeconds: 300,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
        resource: {
          url: "https://api.blockrun.ai/test",
          description: "Test",
        },
      };

      const details = extractPaymentDetails(paymentRequired);

      expect(details.amount).toBe("1000000");
      expect(details.recipient).toBe(TEST_RECIPIENT);
      expect(details.network).toBe("eip155:8453");
      expect(details.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
      expect(details.scheme).toBe("exact");
      expect(details.maxTimeoutSeconds).toBe(300);
      expect(details.resource?.url).toBe("https://api.blockrun.ai/test");
    });

    it("should throw on empty accepts array", () => {
      expect(() =>
        extractPaymentDetails({
          x402Version: 2,
          accepts: [],
        })
      ).toThrow("No payment options");
    });

    it("should use default timeout if not specified", () => {
      const paymentRequired = {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "1000000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: TEST_RECIPIENT,
            // maxTimeoutSeconds not specified
          },
        ],
      };

      const details = extractPaymentDetails(paymentRequired);
      expect(details.maxTimeoutSeconds).toBe(300);
    });
  });
});
