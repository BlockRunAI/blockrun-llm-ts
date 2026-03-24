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
 * Known LLM providers (for optional validation).
 */
export const KNOWN_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "mistralai",
  "meta-llama",
  "together",
  "xai",
  "moonshot",
  "nvidia",
  "minimax",
  "zai",
]);

/**
 * Validates that a model ID is a non-empty string.
 *
 * @param model - The model ID (e.g., "openai/gpt-5.2", "anthropic/claude-sonnet-4.5")
 * @throws {Error} If the model is invalid
 *
 * @example
 * validateModel("openai/gpt-5.2");
 */
export function validateModel(model: string): void {
  if (!model || typeof model !== "string") {
    throw new Error("Model must be a non-empty string");
  }
}

/**
 * Validates that max_tokens is an integer between 1 and 100,000.
 *
 * @param maxTokens - Maximum number of tokens to generate
 * @throws {Error} If maxTokens is invalid
 *
 * @example
 * validateMaxTokens(1000);
 */
export function validateMaxTokens(maxTokens?: number): void {
  if (maxTokens === undefined || maxTokens === null) {
    return;
  }

  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens)) {
    throw new Error("maxTokens must be an integer");
  }

  if (maxTokens < 1) {
    throw new Error("maxTokens must be positive (minimum: 1)");
  }

  if (maxTokens > 100000) {
    throw new Error("maxTokens too large (maximum: 100000)");
  }
}

/**
 * Validates that temperature is a number between 0 and 2.
 *
 * @param temperature - Sampling temperature (0-2)
 * @throws {Error} If temperature is invalid
 *
 * @example
 * validateTemperature(0.7);
 */
export function validateTemperature(temperature?: number): void {
  if (temperature === undefined || temperature === null) {
    return;
  }

  if (typeof temperature !== "number") {
    throw new Error("temperature must be a number");
  }

  if (temperature < 0 || temperature > 2) {
    throw new Error("temperature must be between 0 and 2");
  }
}

/**
 * Validates that top_p is a number between 0 and 1.
 *
 * @param topP - Top-p sampling parameter (0-1)
 * @throws {Error} If topP is invalid
 *
 * @example
 * validateTopP(0.9);
 */
export function validateTopP(topP?: number): void {
  if (topP === undefined || topP === null) {
    return;
  }

  if (typeof topP !== "number") {
    throw new Error("topP must be a number");
  }

  if (topP < 0 || topP > 1) {
    throw new Error("topP must be between 0 and 1");
  }
}

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
