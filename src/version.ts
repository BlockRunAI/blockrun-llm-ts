/**
 * The SDK version reported to the gateway in the User-Agent header.
 *
 * This was duplicated per client and both copies rotted: client.ts said
 * "1.5.0" and solana-client.ts said "0.3.0" while the package was on 3.8.1,
 * so server-side logs attributed live traffic to two versions that had not
 * shipped in a long time and neither of which existed.
 *
 * Keep it here, in one place, and keep it equal to package.json — the
 * "SDK_VERSION matches package.json" case in test/unit/version-consistency.test.ts
 * fails the build if a release bumps the package and forgets this file.
 */
export const SDK_VERSION = "3.8.2";

/** Client identification sent on every gateway request. */
export const USER_AGENT = `blockrun-ts/${SDK_VERSION}`;
