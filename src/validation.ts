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
import { PAYMENT_REPLAY, PaymentError, PaymentReplayError } from "./types";

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
 * Mirrors the gateway's own contract for `max_tokens`, which is exactly
 * `z.number().int().min(1).optional()` — an integer, at least 1, and
 * deliberately **no upper bound**.
 *
 * There is no ceiling here on purpose. The gateway clamps every request with
 * `min(requested, model.maxOutput, contextHeadroom)` and then quotes only a
 * fraction of the clamped value, so an oversized `maxTokens` cannot inflate a
 * payment: 1e9 and 1_000_000 produce a byte-identical quote, because both land
 * on the same `model.maxOutput`. A client-side ceiling could therefore only
 * ever reject a request the gateway would have accepted and handled correctly.
 *
 * Earlier versions of this file did carry one, justified in a comment as
 * stopping a stray 1e9 from "becoming a payment quote". That was never true —
 * it was asserted here without being checked against the route handler, which
 * is the same mistake as the old `"maxTokens too large (maximum: 100000)"`
 * message that got recorded downstream as an upstream model ceiling. Verify
 * against the gateway before reintroducing any number in this file.
 *
 * @param maxTokens - Maximum number of tokens to generate
 * @throws {Error} If maxTokens is not a positive integer
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
/**
 * Whether money moved on a failed call. A paid job can still fail, and a caller
 * who only sees the error may pay for it again, so these survive sanitizing.
 */
const PAYMENT_FACT_FIELDS = ["payment_status", "tx_hash", "payment_note"] as const;

/**
 * One sentence on what a failed response says about the payment. Empty when the
 * response says nothing, or names a status this SDK doesn't know: no statement
 * is safer than a wrong one about money.
 */
export function paymentFactsNote(errorBody: unknown): string {
  if (typeof errorBody !== "object" || errorBody === null) return "";
  const { payment_status: status, tx_hash: txHash } = errorBody as Record<string, unknown>;
  if (status === "settled") {
    const tx = typeof txHash === "string" && txHash ? ` (tx ${txHash})` : "";
    return `. Payment settled${tx}. Do not pay for this job again.`;
  }
  if (status === "unknown") return ". Payment state unknown. Check your wallet before paying again.";
  if (status === "not_charged" || status === "settlement_failed") return ". No payment was taken.";
  return "";
}

export function sanitizeErrorResponse(errorBody: unknown): unknown {
  // If not an object, return generic error
  if (typeof errorBody !== "object" || errorBody === null) {
    return { message: "API request failed" };
  }

  const body = errorBody as Record<string, unknown>;

  // Only expose safe fields.
  //
  // `detail` used to be dropped, and it is the field that carries the actual
  // cause — including whether money moved. A BlockRun gateway 502 looks like:
  //
  //   { error:   "Upstream provider error",
  //     message: "Predexon 500: An unexpected error occurred (payment NOT charged)",
  //     status:  500, endpoint: "...", details: { ... } }
  //
  // Keeping only `error` reduced that to "Upstream provider error", so a caller
  // saw `API error after payment: 502` with no cause and no payment status —
  // and "after payment" asserts a charge the gateway had just said did not
  // happen. Reported as blockrun-mcp#132, where the wallet balance was
  // unchanged while the tool reported a post-payment failure.
  //
  // `message` and `hint` are gateway-authored operator text, the same strings
  // the gateway already returns to unauthenticated callers, so surfacing them
  // exposes nothing the caller could not read from the raw response. Everything
  // else — `details`, `endpoint`, upstream payloads — stays dropped.
  const detail =
    typeof body.message === "string" && body.message !== body.error
      ? body.message
      : undefined;

  return {
    message:
      typeof body.error === "string" ? body.error : "API request failed",
    code: typeof body.code === "string" ? body.code : undefined,
    ...(detail ? { detail } : {}),
    ...(typeof body.hint === "string" ? { hint: body.hint } : {}),
    ...Object.fromEntries(
      PAYMENT_FACT_FIELDS.filter((field) => typeof body[field] === "string").map((field) => [field, body[field]])
    ),
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

// ---------------------------------------------------------------------------
// Refused payments: the ONE place a paid request's 402 becomes an error.
// ---------------------------------------------------------------------------

/**
 * Fields of a `PAYMENT_REPLAY` body kept verbatim on {@link PaymentReplayError}.
 * The gateway's shapes (blockrun `src/lib/payment-nonce.ts`):
 *
 *   402 {error: "Payment authorization already used", message, code, payer}
 *   402 {error: "Payment authorization already settled", code, message,
 *        wallet_auth: {timestamp, message, headers, expires_in}}
 *   202 {status: "in_progress", object: "generation.job", message, code, payer,
 *        id, job_id, poll_url, recoverable: true}   (a job POST; not an error)
 */
const REPLAY_FIELDS = [
  "error",
  "message",
  "details",
  "code",
  "payer",
  "id",
  "job_id",
  "poll_url",
  "recoverable",
  "wallet_auth",
  "status",
] as const;

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function bodyCode(body: Record<string, unknown>): string | undefined {
  if (typeof body.code === "string") return body.code;
  const nested = asRecord(body.error);
  return typeof nested.code === "string" ? nested.code : undefined;
}

/**
 * Does this response body say `code: "PAYMENT_REPLAY"`? The gateway sends it
 * when the signed authorization was already submitted once. The earlier
 * request may have been served and charged, so the answer is never "sign a new
 * payment and try again".
 */
export function isPaymentReplay(body: unknown): boolean {
  return bodyCode(asRecord(body))?.toUpperCase() === PAYMENT_REPLAY;
}

/**
 * Does a refusal point at an earlier request's result (`recoverable`,
 * `poll_url`, `job_id`, `wallet_auth`)? The chat path treats that as replay
 * evidence even without the code, as the Python SDK does.
 * @internal
 */
export function namesEarlierResult(body: unknown): boolean {
  const record = asRecord(body);
  return ["recoverable", "poll_url", "job_id", "wallet_auth"].some((key) => Boolean(record[key]));
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length < max ? value : undefined;
}

function replayError(body: Record<string, unknown>, statusCode: number): PaymentReplayError {
  const detail: Record<string, unknown> = {};
  for (const key of REPLAY_FIELDS) if (body[key] !== undefined && body[key] !== null) detail[key] = body[key];
  detail.code = PAYMENT_REPLAY;
  for (const field of PAYMENT_FACT_FIELDS) if (typeof body[field] === "string") detail[field] = body[field];
  const serverMessage = typeof body.message === "string" ? body.message : "";
  const pollUrl = typeof body.poll_url === "string" ? body.poll_url : "";
  const details = typeof body.details === "string" ? body.details : "";
  let text =
    "Payment authorization already used (PAYMENT_REPLAY): an earlier request " +
    "with this authorization was accepted and may already have been charged. " +
    "Nothing new was signed; a fresh payment for the same request can charge twice.";
  if (pollUrl) text += ` Its result can be collected at ${pollUrl}.`;
  if (serverMessage) text += ` Gateway: ${serverMessage}`;
  if (details && details !== serverMessage) text += ` (${details})`;
  return new PaymentReplayError(text, { statusCode, response: detail });
}

/**
 * Turn a refused payment's body into the error to throw.
 *
 * - `code: "PAYMENT_REPLAY"` (or `replay: true`, for a caller with its own
 *   evidence) gives a {@link PaymentReplayError} carrying the gateway's
 *   `message`, `details`, `poll_url`, `job_id`, `wallet_auth` and `payer`
 *   verbatim. Callers must not answer it by signing again.
 * - Anything else gives a {@link PaymentError} whose message is the gateway's
 *   reason. Clients used to throw "Payment was rejected. Check your wallet
 *   balance." for every 402, which hid `PAYMENT_MALFORMED`, facilitator
 *   reasons and already-used authorizations behind a balance guess.
 *
 * Mirrors the Python SDK's `validation.build_payment_rejected_error`.
 */
export function paymentRejectedErrorFromBody(
  body: unknown,
  statusCode = 402,
  options: { replay?: boolean } = {}
): PaymentError {
  const record = asRecord(body);
  if (options.replay ?? isPaymentReplay(record)) return replayError(record, statusCode);

  const sanitized = { ...(sanitizeErrorResponse(record) as Record<string, unknown>) };
  // The facilitator's `details` enum and `invalidMessage` cause are safe to
  // surface verbatim; bounded defensively all the same.
  const details = boundedString(record.details, 256);
  if (details) sanitized.details = details;
  const invalidMessage = boundedString(record.invalidMessage, 256);
  if (invalidMessage) sanitized.invalidMessage = invalidMessage;
  const reason = boundedString(record.reason, 128);
  if (reason) sanitized.reason = reason;

  const nested = asRecord(record.error);
  const title = typeof record.error === "string" ? record.error : typeof nested.message === "string" ? nested.message : "";
  const serverMessage = typeof record.message === "string" ? record.message : "";
  let detailPart = details || title;
  // A flat body's prose `message` beside its short `error` title is the
  // gateway's actual explanation (PAYMENT_MALFORMED names the bad field).
  if (!details && serverMessage && serverMessage !== detailPart) {
    detailPart = detailPart ? `${detailPart}: ${serverMessage}` : serverMessage;
  }
  if (invalidMessage) detailPart = detailPart ? `${detailPart} (${invalidMessage})` : invalidMessage;
  const message = detailPart
    ? `Payment rejected by gateway: ${detailPart}`
    : `Payment rejected by gateway (HTTP ${statusCode}); it gave no reason`;
  return new PaymentError(message, { statusCode, response: sanitized });
}

/**
 * Read a refused payment's response and turn it into the error to throw. See
 * {@link paymentRejectedErrorFromBody}. Consumes the body.
 */
export async function buildPaymentRejectedError(
  response: Response,
  options: { replay?: (body: unknown) => boolean } = {}
): Promise<PaymentError> {
  let body: unknown;
  try {
    const text = await response.text();
    body = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    body = {};
  }
  const replay = options.replay ? options.replay(body) || undefined : undefined;
  return paymentRejectedErrorFromBody(body, response.status, { replay });
}
