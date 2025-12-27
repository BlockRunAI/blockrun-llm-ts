import { describe, it, expect } from "vitest";
import {
  validatePrivateKey,
  validateApiUrl,
  sanitizeErrorResponse,
  validateResourceUrl,
  extractPrivateKey,
} from "../../src/validation";
import { TEST_ACCOUNT } from "../helpers/testHelpers";

describe("Validation Module", () => {
  describe("validatePrivateKey", () => {
    it("should accept valid private key", () => {
      expect(() =>
        validatePrivateKey(
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        )
      ).not.toThrow();
    });

    it("should reject non-string input", () => {
      expect(() => validatePrivateKey(123 as any)).toThrow(
        "Private key must be a string"
      );
    });

    it("should reject key without 0x prefix", () => {
      expect(() =>
        validatePrivateKey(
          "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        )
      ).toThrow("must start with 0x");
    });

    it("should reject short key", () => {
      expect(() => validatePrivateKey("0x123")).toThrow("66 characters");
    });

    it("should reject long key", () => {
      expect(() =>
        validatePrivateKey(
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80123"
        )
      ).toThrow("66 characters");
    });

    it("should reject non-hex characters", () => {
      expect(() =>
        validatePrivateKey(
          "0xGGGG74bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        )
      ).toThrow("hexadecimal");
    });

    it("should accept uppercase hex", () => {
      expect(() =>
        validatePrivateKey(
          "0xAC0974BEC39A17E36BA4A6B4D238FF944BACB478CBED5EFCAE784D7BF4F2FF80"
        )
      ).not.toThrow();
    });

    it("should accept mixed case hex", () => {
      expect(() =>
        validatePrivateKey(
          "0xAc0974Bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        )
      ).not.toThrow();
    });
  });

  describe("validateApiUrl", () => {
    it("should accept HTTPS URLs", () => {
      expect(() => validateApiUrl("https://api.blockrun.ai")).not.toThrow();
      expect(() => validateApiUrl("https://example.com:8443")).not.toThrow();
    });

    it("should accept localhost HTTP", () => {
      expect(() => validateApiUrl("http://localhost")).not.toThrow();
      expect(() => validateApiUrl("http://localhost:3000")).not.toThrow();
      expect(() => validateApiUrl("http://127.0.0.1")).not.toThrow();
      expect(() => validateApiUrl("http://127.0.0.1:8080")).not.toThrow();
    });

    it("should reject HTTP for non-localhost", () => {
      expect(() => validateApiUrl("http://api.example.com")).toThrow("HTTPS");
      expect(() => validateApiUrl("http://192.168.1.1")).toThrow("HTTPS");
    });

    it("should reject invalid URL format", () => {
      expect(() => validateApiUrl("not-a-url")).toThrow("Invalid");
      expect(() => validateApiUrl("")).toThrow("Invalid");
      expect(() => validateApiUrl("ftp://example.com")).toThrow("Invalid protocol");
    });

    it("should reject URL without protocol", () => {
      expect(() => validateApiUrl("api.blockrun.ai")).toThrow("Invalid");
    });
  });

  describe("sanitizeErrorResponse", () => {
    it("should extract safe error message", () => {
      const result = sanitizeErrorResponse({
        error: "User-facing error",
        internal_stack: "/var/app/sensitive/path.js:123",
        api_key: "sk-secret123",
        database_url: "postgres://user:pass@host/db",
      });

      expect(result).toEqual({
        message: "User-facing error",
        code: undefined,
      });
    });

    it("should include code if present", () => {
      const result = sanitizeErrorResponse({
        error: "Invalid request",
        code: "invalid_request_error",
      });

      expect(result).toEqual({
        message: "Invalid request",
        code: "invalid_request_error",
      });
    });

    it("should handle non-object input", () => {
      expect(sanitizeErrorResponse("string error")).toEqual({
        message: "API request failed",
      });
      expect(sanitizeErrorResponse(null)).toEqual({
        message: "API request failed",
      });
      expect(sanitizeErrorResponse(undefined)).toEqual({
        message: "API request failed",
      });
      expect(sanitizeErrorResponse(123)).toEqual({
        message: "API request failed",
      });
    });

    it("should handle missing error field", () => {
      const result = sanitizeErrorResponse({
        something: "else",
        internal: "data",
      });

      expect(result).toEqual({
        message: "API request failed",
        code: undefined,
      });
    });

    it("should ignore non-string error values", () => {
      const result = sanitizeErrorResponse({
        error: { nested: "object" },
      });

      expect(result).toEqual({
        message: "API request failed",
        code: undefined,
      });
    });

    it("should ignore non-string code values", () => {
      const result = sanitizeErrorResponse({
        error: "Test error",
        code: 123,
      });

      expect(result).toEqual({
        message: "Test error",
        code: undefined,
      });
    });
  });

  describe("validateResourceUrl", () => {
    it("should allow matching domain", () => {
      const result = validateResourceUrl(
        "https://api.blockrun.ai/v1/chat/completions",
        "https://api.blockrun.ai"
      );
      expect(result).toBe("https://api.blockrun.ai/v1/chat/completions");
    });

    it("should allow matching domain with different paths", () => {
      const result = validateResourceUrl(
        "https://api.blockrun.ai/v2/models",
        "https://api.blockrun.ai"
      );
      expect(result).toBe("https://api.blockrun.ai/v2/models");
    });

    it("should reject different domain", () => {
      const result = validateResourceUrl(
        "https://malicious.com/steal-data",
        "https://api.blockrun.ai"
      );
      expect(result).toBe("https://api.blockrun.ai/v1/chat/completions");
    });

    it("should reject different protocol", () => {
      const result = validateResourceUrl(
        "http://api.blockrun.ai/v1/chat",
        "https://api.blockrun.ai"
      );
      expect(result).toBe("https://api.blockrun.ai/v1/chat/completions");
    });

    it("should handle invalid URL format", () => {
      const result = validateResourceUrl(
        "not-a-valid-url",
        "https://api.blockrun.ai"
      );
      expect(result).toBe("https://api.blockrun.ai/v1/chat/completions");
    });

    it("should handle subdomain differences", () => {
      const result = validateResourceUrl(
        "https://evil.api.blockrun.ai/v1/chat",
        "https://api.blockrun.ai"
      );
      expect(result).toBe("https://api.blockrun.ai/v1/chat/completions");
    });
  });

  describe("extractPrivateKey", () => {
    it("should extract private key from account with source property", () => {
      const key = extractPrivateKey(TEST_ACCOUNT);
      expect(key).toBe(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
      );
      expect(key.startsWith("0x")).toBe(true);
      expect(key.length).toBe(66);
    });

    it("should throw for account without source or key", () => {
      const invalidAccount = { address: "0x123" } as any;
      expect(() => extractPrivateKey(invalidAccount)).toThrow(
        "Unable to extract private key"
      );
    });
  });
});
