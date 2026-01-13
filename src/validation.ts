/**
 * Input validation and security utilities for BlockRun LLM SDK.
 *
 * This module provides validation functions to ensure:
 * - Private keys are properly formatted
 * - API URLs use HTTPS
 * - Server responses don't leak sensitive information
 * - Resource URLs match expected domains
 */

import type { Account } from "viem/accounts";

/**
 * Allowed domains for localhost development.
 * Production domains are enforced to use HTTPS.
 */
const LOCALHOST_DOMAINS = ["localhost", "127.0.0.1"];

/**
 * Validates that a private key is properly formatted.
 *
 * @param key - The private key to validate
 * @throws {Error} If the key format is invalid
 *
 * @example
 * validatePrivateKey("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
 */
export function validatePrivateKey(key: string): void {
  // Must be a string
  if (typeof key !== "string") {
    throw new Error("Private key must be a string");
  }

  // Must start with 0x
  if (!key.startsWith("0x")) {
    throw new Error("Private key must start with 0x");
  }

  // Must be exactly 66 characters (0x + 64 hex chars)
  if (key.length !== 66) {
    throw new Error(
      "Private key must be 66 characters (0x + 64 hexadecimal characters)"
    );
  }

  // Must contain only valid hexadecimal characters
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "Private key must contain only hexadecimal characters (0-9, a-f, A-F)"
    );
  }
}

/**
 * Validates that an API URL is secure and properly formatted.
 *
 * @param url - The API URL to validate
 * @throws {Error} If the URL is invalid or insecure
 *
 * @example
 * validateApiUrl("https://blockrun.ai/api");
 * validateApiUrl("http://localhost:3000"); // OK for development
 */
export function validateApiUrl(url: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid API URL format");
  }

  // Ensure we have a valid protocol first
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid protocol: ${parsed.protocol}. Use http:// or https://`
    );
  }

  // Check HTTPS requirement for non-localhost
  const isLocalhost = LOCALHOST_DOMAINS.includes(parsed.hostname);

  if (parsed.protocol !== "https:" && !isLocalhost) {
    throw new Error(
      "API URL must use HTTPS for non-localhost endpoints. " +
        `Use https:// instead of ${parsed.protocol}//`
    );
  }
}

/**
 * Sanitizes API error responses to prevent information leakage.
 *
 * Only exposes safe error fields to the caller, filtering out:
 * - Internal stack traces
 * - Server-side paths
 * - API keys or tokens
 * - Debugging information
 *
 * @param errorBody - The raw error response from the API
 * @returns Sanitized error object with only safe fields
 *
 * @example
 * const sanitized = sanitizeErrorResponse({
 *   error: "Invalid model",
 *   internal_stack: "/var/app/handler.js:123",
 *   api_key: "secret"
 * });
 * // Returns: { message: "Invalid model", code: undefined }
 */
export function sanitizeErrorResponse(errorBody: unknown): unknown {
  // If not an object, return generic error
  if (typeof errorBody !== "object" || errorBody === null) {
    return { message: "API request failed" };
  }

  const body = errorBody as Record<string, unknown>;

  // Only expose safe fields
  return {
    message:
      typeof body.error === "string" ? body.error : "API request failed",
    code: typeof body.code === "string" ? body.code : undefined,
  };
}

/**
 * Validates a resource URL from the server to prevent redirection attacks.
 *
 * Ensures that the resource URL's hostname matches the API's hostname.
 * If domains don't match, returns a safe default URL instead.
 *
 * @param url - The resource URL provided by the server
 * @param baseUrl - The base API URL (trusted)
 * @returns The validated URL or a safe default
 *
 * @example
 * validateResourceUrl(
 *   "https://blockrun.ai/api/v1/chat",
 *   "https://blockrun.ai/api"
 * );
 * // Returns: "https://blockrun.ai/api/v1/chat"
 *
 * validateResourceUrl(
 *   "https://malicious.com/steal",
 *   "https://blockrun.ai/api"
 * );
 * // Returns: "https://blockrun.ai/api/v1/chat/completions" (safe default)
 */
export function validateResourceUrl(url: string, baseUrl: string): string {
  try {
    const parsed = new URL(url);
    const baseParsed = new URL(baseUrl);

    // Resource URL hostname must match API hostname
    if (parsed.hostname !== baseParsed.hostname) {
      console.warn(
        `Resource URL hostname mismatch: ${parsed.hostname} vs ${baseParsed.hostname}. ` +
          `Using safe default instead.`
      );
      return `${baseUrl}/v1/chat/completions`;
    }

    // Ensure resource uses same protocol as base
    if (parsed.protocol !== baseParsed.protocol) {
      console.warn(
        `Resource URL protocol mismatch: ${parsed.protocol} vs ${baseParsed.protocol}. ` +
          `Using safe default instead.`
      );
      return `${baseUrl}/v1/chat/completions`;
    }

    return url;
  } catch {
    // Invalid URL format, return safe default
    console.warn(`Invalid resource URL format: ${url}. Using safe default.`);
    return `${baseUrl}/v1/chat/completions`;
  }
}

/**
 * Safely extracts the private key from a viem Account object.
 *
 * Note: Modern viem versions (2.x+) do NOT expose the private key on the
 * Account object - the 'source' property contains the account type name
 * (e.g., "privateKey"), not the actual key. The BlockRun SDK stores the
 * private key separately in the client constructors.
 *
 * @param account - The viem Account object
 * @returns The private key as a hex string
 * @throws {Error} If the private key cannot be extracted
 *
 * @internal
 * @deprecated Use the private key stored in client instead
 */
export function extractPrivateKey(account: Account): `0x${string}` {
  // Check 'source' property - must be a valid hex private key, not just a string
  if ("source" in account && typeof account.source === "string") {
    const source = account.source;
    // Validate it looks like a private key (0x + 64 hex chars)
    if (source.startsWith("0x") && source.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(source)) {
      return source as `0x${string}`;
    }
  }

  // Check 'key' property (older viem versions)
  if ("key" in account && typeof account.key === "string") {
    const key = account.key as string;
    if (key.startsWith("0x") && key.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(key)) {
      return key as `0x${string}`;
    }
  }

  throw new Error(
    "Unable to extract private key from account. " +
      "This may indicate an incompatible viem version."
  );
}
