/**
 * Proof of job ownership for Solana async media polls, WITHOUT a payment.
 *
 * On Solana a signed payment is a transaction pinned to a recent blockhash
 * (~60-90s of life), so polling a multi-minute job with x402 meant signing a
 * fresh payment on every poll. sol.blockrun.ai also accepts this proof instead:
 * the wallet that paid the submit POST signs a short text message naming the
 * job with its ed25519 key. No transaction, no blockhash, nothing a facilitator
 * can settle.
 *
 *   message   = "blockrun-poll:v1:<kind>:<job id from the poll_url path>:<unix seconds>"
 *   headers   x-poll-wallet:    base58 32-byte public key of the submitting wallet
 *             x-poll-timestamp: the <unix seconds> in the message
 *             x-poll-signature: base58 64-byte ed25519 signature over the UTF-8 message
 *
 * Mirrors sol's `src/lib/poll-ownership.ts`; the server accepts a timestamp
 * within ±300s of its clock, so a fresh proof is signed for every poll.
 * Solana (sol.blockrun.ai) only — the Base gateway does not read these headers.
 */
import { createPrivateKey, createPublicKey, sign as ed25519Sign } from "crypto";
import bs58 from "bs58";

/** The job types the gateway accepts a poll proof for. Music jobs are `audio`. */
export type PollKind = "video" | "audio" | "image";

export const POLL_AUTH_HEADERS = {
  wallet: "x-poll-wallet",
  timestamp: "x-poll-timestamp",
  signature: "x-poll-signature",
} as const;

/** The exact string the wallet signs. Byte-for-byte what the gateway verifies. */
export function pollAuthMessage(kind: PollKind, jobId: string, timestampS: number): string {
  return `blockrun-poll:v1:${kind}:${jobId}:${timestampS}`;
}

/**
 * The job id the gateway verifies the proof against: the last path segment of
 * `poll_url`, URL-decoded (the route reads `decodeURIComponent(params.id)`).
 * The query string (video's signed `?model=&duration=&sig=`) is not part of it.
 */
export function pollJobIdFromUrl(pollUrl: string): string {
  const path = new URL(pollUrl, "https://placeholder.invalid").pathname.replace(/\/+$/, "");
  const segment = path.slice(path.lastIndexOf("/") + 1);
  if (!segment) throw new Error(`poll_url has no job id segment: ${pollUrl}`);
  return decodeURIComponent(segment);
}

// RFC 8410 PKCS#8 prefix for an Ed25519 private key; the 32-byte seed follows.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Sign a poll-ownership proof with a Solana secret key.
 *
 * @param secretKey - the wallet's 64-byte Solana secret key (seed ‖ public key)
 *   or its 32-byte seed. The public key is derived from the seed — the same
 *   seed that signs the wallet's payments — so `x-poll-wallet` is always the
 *   address that paid the submit.
 * @param kind - `video`, `audio` (music) or `image`.
 * @param jobId - see {@link pollJobIdFromUrl}.
 * @param nowMs - clock override for tests.
 * @returns the three `x-poll-*` headers.
 */
export function signPollOwnership(
  secretKey: Uint8Array,
  kind: PollKind,
  jobId: string,
  nowMs: number = Date.now()
): Record<string, string> {
  if (secretKey.length !== 64 && secretKey.length !== 32) {
    throw new Error(`Solana secret key must be 64 bytes (or a 32-byte seed), got ${secretKey.length}`);
  }
  const seed = Buffer.from(secretKey.subarray(0, 32));
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("Could not derive the Ed25519 public key");
  const publicKey = Buffer.from(jwk.x, "base64url");

  const timestampS = Math.floor(nowMs / 1000);
  const signature = ed25519Sign(null, Buffer.from(pollAuthMessage(kind, jobId, timestampS), "utf8"), privateKey);

  return {
    [POLL_AUTH_HEADERS.wallet]: bs58.encode(publicKey),
    [POLL_AUTH_HEADERS.timestamp]: String(timestampS),
    [POLL_AUTH_HEADERS.signature]: bs58.encode(signature),
  };
}
