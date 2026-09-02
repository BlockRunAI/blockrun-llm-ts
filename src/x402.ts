/**
 * x402 Payment Protocol v2 Implementation for BlockRun.
 *
 * This module handles creating signed payment payloads for the x402 v2 protocol.
 * The private key is used ONLY for local signing and NEVER leaves the client.
 */

import { signTypedData } from "viem/accounts";
import type { PaymentRequired, ResourceInfo } from "./types";
import { loadSolanaWeb3, loadSplToken } from "./solana-deps.js";

// Chain and token constants
export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// Solana constants
export const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_USDC_DECIMALS = 6;

// Compute budget constants matching @x402/svm
const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;
const DEFAULT_COMPUTE_UNIT_LIMIT = 8000;

// --- Solana payment fast path ----------------------------------------------
// Two RPC round-trips used to sit on the critical path of EVERY Solana payment
// (measured ~107ms each, ~212ms serial, against sol.blockrun.ai): getMint, to
// read `decimals`, and getLatestBlockhash.
//
// getMint is gone outright: SPL Token fixes `decimals` in InitializeMint and
// ships no instruction to change it, so a mint's decimals is immutable, and
// this path only ever transfers USDC — whose decimals this module already
// exports as SOLANA_USDC_DECIMALS. Fetching a hardcoded 6 over the network was
// pure latency. getLatestBlockhash is cached; see below for why that is safe.

/**
 * A blockhash is valid for ~150 slots (~60s). The default RPC already caches
 * `getLatestBlockhash` for 30s server-side, so a value can be 30s old on
 * arrival; a 10s client TTL keeps the worst case at ~40s and leaves ~20s of
 * settlement margin.
 */
const BLOCKHASH_TTL_MS = 10_000;

/**
 * How many times the priority fee may be nudged to distinguish two otherwise
 * identical payments on one blockhash. Each step is +1 microLamport/CU over
 * 8000 CU = 0.008 lamports, paid by the facilitator fee payer, so the whole
 * range costs under a lamport. The top of the range, 65 microLamports/CU, is
 * three orders of magnitude under the facilitator's 50_000 ceiling.
 */
const MAX_FEE_NONCE_STEPS = 64;

/** How many blockhashes keep a duplicate-guard record. */
const MAX_TRACKED_BLOCKHASHES = 8;

/** How many RPC endpoints keep a cached blockhash. */
const MAX_TRACKED_ENDPOINTS = 8;

interface BlockhashEntry {
  blockhash: string;
  fetchedAt: number;
}

/**
 * Latest blockhash per RPC endpoint. Keyed by URL because endpoints genuinely
 * differ on what "latest" is, and because a client alternating between a
 * primary and a fallback would otherwise evict the entry on every call.
 *
 * Bounded the same way as the record below: a caller that builds a fresh URL
 * per request — a rotating token in a query string, say — would otherwise leave
 * one dead entry behind forever.
 */
const blockhashCache = new Map<string, BlockhashEntry>();

/** Drop the oldest keys until `map` is back within `limit`. */
function trimOldest(map: Map<string, unknown>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value as string;
    map.delete(oldest);
  }
}

/**
 * Serialized transactions already produced against a given blockhash.
 *
 * Two payments that share a blockhash AND have identical economics compile to a
 * byte-identical message. ed25519 is deterministic, so they yield the SAME
 * signature, and Solana rejects the second as an already-processed duplicate.
 * Two same-priced calls in a row is a completely ordinary agent pattern, so
 * reusing a blockhash without this guard would break them.
 *
 * Keyed by BLOCKHASH, not by endpoint. A signed transaction's identity depends
 * only on its blockhash and its economics — Solana never sees which URL served
 * the blockhash — so two endpoints handing back the same blockhash must consult
 * one shared record. Filing this per endpoint let a fallback RPC start from an
 * empty record and re-emit bytes the primary had already sent.
 */
const issuedByBlockhash = new Map<string, Set<string>>();

function issuedFor(blockhash: string): Set<string> {
  let issued = issuedByBlockhash.get(blockhash);
  if (!issued) {
    issued = new Set();
    issuedByBlockhash.set(blockhash, issued);
    // A blockhash expires in ~60s, so a transaction built against an older one
    // cannot land no matter what this map says. A small insertion-ordered
    // window is therefore enough, and it keeps memory bounded for a
    // long-running process that would otherwise accumulate every blockhash and
    // every transaction it ever signed. Trimming the OLDEST is what makes this
    // safe: the blockhash being paid against right now is the one just
    // inserted, so it is never the one dropped.
    trimOldest(issuedByBlockhash, MAX_TRACKED_BLOCKHASHES);
  }
  return issued;
}

async function getBlockhashEntry(
  connection: { getLatestBlockhash: () => Promise<{ blockhash: string }> },
  rpcUrl: string,
  forceRefresh: boolean
): Promise<BlockhashEntry> {
  const now = Date.now();
  const cached = blockhashCache.get(rpcUrl);
  if (!forceRefresh && cached && now - cached.fetchedAt < BLOCKHASH_TTL_MS) {
    return cached;
  }
  const { blockhash } = await connection.getLatestBlockhash();
  // Re-read rather than reuse the pre-await snapshot. Payments fired together
  // are all in flight here at once — a real RPC takes ~107ms — so a sibling may
  // have stored an entry while this one waited, and the stale snapshot would
  // miss it and churn out a replacement for a blockhash already cached.
  const current = blockhashCache.get(rpcUrl);
  if (current?.blockhash === blockhash) {
    // Server-side caching can hand back the same hash. Keep the entry so its
    // TTL reflects the last time this value was actually confirmed as latest.
    current.fetchedAt = now;
    return current;
  }
  const entry: BlockhashEntry = { blockhash, fetchedAt: now };
  blockhashCache.set(rpcUrl, entry);
  trimOldest(blockhashCache, MAX_TRACKED_ENDPOINTS);
  return entry;
}

/** Test seam: drop cached state so a test starts from a cold client. */
export function __resetSolanaPaymentCaches(): void {
  blockhashCache.clear();
  issuedByBlockhash.clear();
}

// EIP-712 domain for Base USDC
const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_BASE,
} as const;

// EIP-712 types for TransferWithAuthorization
const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Generate a random bytes32 nonce.
 */
function createNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
}

/**
 * BlockRun's x402 builder code — the ERC-8021 Schema 2 service code (`s`) that
 * tags every payment this SDK signs as BlockRun-originated for on-chain
 * attribution. See https://docs.cdp.coinbase.com/x402/core-concepts/builder-codes
 */
export const BLOCKRUN_SERVICE_CODE = "blockrun";

/**
 * Merge BlockRun's service code (`s`) into the payload's `builder-code`
 * extension, preserving any app code (`a`) the server echoed back in its 402.
 * The CDP facilitator reads `builder-code.info.s` and encodes it into the
 * settlement calldata suffix — no CBOR/encoding happens client-side.
 */
function withBuilderCodeServiceCode(
  extensions?: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(extensions || {}) };
  const existing =
    (merged["builder-code"] as { info?: Record<string, unknown> } | undefined) || {};
  merged["builder-code"] = {
    ...existing,
    info: { ...(existing.info || {}), s: [BLOCKRUN_SERVICE_CODE] },
  };
  return merged;
}

export interface CreatePaymentOptions {
  resourceUrl?: string;
  resourceDescription?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
  extensions?: Record<string, unknown>;
}

/**
 * Create a signed x402 v2 payment payload.
 *
 * @param privateKey - Hex-encoded private key
 * @param fromAddress - Sender wallet address
 * @param recipient - Payment recipient address
 * @param amount - Amount in micro USDC (6 decimals)
 * @param network - Network identifier (default: eip155:8453)
 * @param options - Additional options for resource info
 * @returns Base64-encoded signed payment payload
 */
export async function createPaymentPayload(
  privateKey: `0x${string}`,
  fromAddress: string,
  recipient: string,
  amount: string,
  network: string = "eip155:8453",
  options: CreatePaymentOptions = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 600; // 10 minutes before (allows for clock skew)
  const validBefore = now + (options.maxTimeoutSeconds || 300);
  const nonce = createNonce();

  // USDC domain is fixed - NEVER use extra values from payment requirements
  // The USDC contract on Base uses exactly "USD Coin" version "2"
  const domain = USDC_DOMAIN;

  // Sign using EIP-712 (private key used locally, never transmitted)
  const signature = await signTypedData({
    privateKey,
    domain,
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: fromAddress as `0x${string}`,
      to: recipient as `0x${string}`,
      value: BigInt(amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  // Create x402 v2 payment payload
  const paymentData = {
    x402Version: 2,
    resource: {
      url: options.resourceUrl || "https://blockrun.ai/api/v1/chat/completions",
      description: options.resourceDescription || "BlockRun AI API call",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network,
      amount,
      asset: USDC_BASE,
      payTo: recipient,
      maxTimeoutSeconds: options.maxTimeoutSeconds || 300,
      extra: { name: "USD Coin", version: "2" },
    },
    payload: {
      signature,
      authorization: {
        from: fromAddress,
        to: recipient,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
    extensions: withBuilderCodeServiceCode(options.extensions),
  };

  // Encode as base64
  return btoa(JSON.stringify(paymentData));
}

export interface CreateSolanaPaymentOptions {
  resourceUrl?: string;
  resourceDescription?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  rpcUrl?: string;
  /**
   * Optional HTTP headers forwarded to the Solana RPC endpoint
   * (e.g. `{ "x-api-key": "..." }` for Tatum / header-auth gateways).
   */
  rpcHeaders?: Record<string, string>;
  /**
   * Skip the client blockhash cache and ask the RPC for a current one.
   *
   * Set this ONLY when the previous attempt was rejected for a stale
   * blockhash. The cache TTL (10s) is longer than any sane retry backoff, so a
   * re-sign that leaves this false gets the SAME expired hash back, and the
   * duplicate guard then nudges the priority fee — producing fresh transaction
   * bytes pinned to the very blockhash the server just rejected. The retry
   * looks like it did something and is guaranteed to fail identically.
   *
   * Not a guarantee of a different hash: the default RPC caches
   * `getLatestBlockhash` for 30s server-side and may hand back the same value.
   * It is the strongest thing a client can do, and the guard below still
   * ensures the bytes differ.
   */
  forceFreshBlockhash?: boolean;
}

/**
 * Create a signed Solana x402 v2 payment payload.
 *
 * This creates an SPL TransferChecked transaction for USDC payment
 * that the CDP facilitator can verify and settle.
 *
 * Requires @solana/web3.js and @solana/spl-token dependencies.
 *
 * @param secretKey - Solana secret key (Uint8Array, 64 bytes)
 * @param fromAddress - Sender wallet address (base58)
 * @param recipient - Payment recipient address (base58)
 * @param amount - Amount in micro USDC (6 decimals)
 * @param feePayer - CDP facilitator fee payer address (base58)
 * @param options - Additional options
 * @returns Base64-encoded signed payment payload
 */
export async function createSolanaPaymentPayload(
  secretKey: Uint8Array,
  fromAddress: string,
  recipient: string,
  amount: string,
  feePayer: string,
  options: CreateSolanaPaymentOptions = {}
): Promise<string> {
  // Dynamic import to avoid bundling Solana deps when not needed. These are
  // optional PEER dependencies — npm does not install them, so the loaders turn
  // a bare ERR_MODULE_NOT_FOUND into an actionable message.
  const {
    Connection,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    Keypair,
  } = await loadSolanaWeb3("createSolanaPaymentPayload()");
  const { getAssociatedTokenAddress, createTransferCheckedInstruction } = await loadSplToken(
    "createSolanaPaymentPayload()"
  );

  const rpcUrl = options.rpcUrl || "https://sol.blockrun.ai/api/v1/solana/rpc";
  const connection = options.rpcHeaders
    ? new Connection(rpcUrl, { httpHeaders: options.rpcHeaders })
    : new Connection(rpcUrl);

  // Create keypair from secret key
  const keypair = Keypair.fromSecretKey(secretKey);

  // Parse addresses
  const feePayerPubkey = new PublicKey(feePayer);
  const ownerPubkey = keypair.publicKey;
  const tokenMint = new PublicKey(USDC_SOLANA);
  const payToPubkey = new PublicKey(recipient);

  // Pure PDA derivation — no RPC.
  const sourceATA = await getAssociatedTokenAddress(tokenMint, ownerPubkey, false);
  const destinationATA = await getAssociatedTokenAddress(tokenMint, payToPubkey, false);

  // Create transfer checked instruction
  const transferIx = createTransferCheckedInstruction(
    sourceATA,
    tokenMint,
    destinationATA,
    ownerPubkey,
    BigInt(amount),
    SOLANA_USDC_DECIMALS
  );

  const buildSignedTx = (blockhash: string, unitPriceMicroLamports: number): string => {
    // Create v0 transaction message - order matches @x402/svm: limit, price, transfer
    const messageV0 = new TransactionMessage({
      payerKey: feePayerPubkey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNIT_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: unitPriceMicroLamports }),
        transferIx,
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    // Sign with wallet (partial signature - only the transfer authority)
    transaction.sign([keypair]);
    return Buffer.from(transaction.serialize()).toString("base64");
  };

  /**
   * First transaction against `entry` that has not been issued yet, or null if
   * the whole fee-nonce range collides.
   *
   * Step 0 is the default price, so the common case costs exactly one sign and
   * no network call. Beyond that, identical economics on a reused blockhash are
   * resolved by nudging the priority fee rather than by fetching: repeated
   * same-priced calls are the NORMAL agent pattern, and 8000 CU at
   * +1 microLamport/CU is 0.008 lamports paid by the facilitator fee payer, so
   * it is not the user's cost either.
   */
  const findDistinctTx = (candidate: BlockhashEntry): string | null => {
    const issued = issuedFor(candidate.blockhash);
    for (let step = 0; step <= MAX_FEE_NONCE_STEPS; step++) {
      const tx = buildSignedTx(
        candidate.blockhash,
        DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS + step
      );
      if (!issued.has(tx)) return tx;
    }
    return null;
  };

  let entry = await getBlockhashEntry(connection, rpcUrl, options.forceFreshBlockhash ?? false);
  let serializedTx = findDistinctTx(entry);

  if (serializedTx === null) {
    // Exhausting the range is the one case worth paying for a fresh blockhash —
    // simply the pre-cache behaviour. But a forced refresh can legitimately
    // hand back the SAME blockhash (the RPC caches it 30s server-side), and the
    // record of what was issued against it is keyed by that blockhash, so it
    // survives. The search therefore has to run again over whatever comes back
    // rather than restarting at the default price, which on an unchanged
    // blockhash would rebuild the very first transaction.
    entry = await getBlockhashEntry(connection, rpcUrl, true);
    serializedTx = findDistinctTx(entry);
  }

  if (serializedTx === null) {
    // Never emit a transaction known to be a byte-identical duplicate — Solana
    // would reject it as already-processed with nothing explaining why.
    throw new Error(
      `Solana payment: ${MAX_FEE_NONCE_STEPS + 1} identical payments already issued ` +
        `against blockhash ${entry.blockhash}. Retry once it rotates.`
    );
  }

  issuedFor(entry.blockhash).add(serializedTx);

  // Create x402 v2 payment payload
  const paymentData = {
    x402Version: 2,
    resource: {
      url: options.resourceUrl || "https://blockrun.ai/api/v1/chat/completions",
      description: options.resourceDescription || "BlockRun AI API call",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: SOLANA_NETWORK,
      amount,
      asset: USDC_SOLANA,
      payTo: recipient,
      maxTimeoutSeconds: options.maxTimeoutSeconds || 300,
      extra: options.extra || { feePayer },
    },
    payload: {
      transaction: serializedTx,
    },
    extensions: withBuilderCodeServiceCode(options.extensions),
  };

  // Encode as base64
  return btoa(JSON.stringify(paymentData));
}

/**
 * Parse the X-Payment-Required header from a 402 response.
 *
 * @param headerValue - Base64-encoded payment required header
 * @returns Parsed payment required object
 * @throws {Error} If the header cannot be parsed or has invalid structure
 */
export function parsePaymentRequired(headerValue: string): PaymentRequired {
  try {
    // Decode base64
    const decoded = atob(headerValue);
    const parsed = JSON.parse(decoded);

    // Validate structure
    if (!parsed.accepts || !Array.isArray(parsed.accepts)) {
      throw new Error("Invalid payment required structure: missing or invalid 'accepts' field");
    }

    return parsed as PaymentRequired;
  } catch (error) {
    if (error instanceof Error) {
      // Re-throw validation errors as-is
      if (error.message.includes("Invalid payment required structure")) {
        throw error;
      }
      // Sanitize parsing errors. The message stays deliberately vague — the
      // header is attacker-reachable — but the original is kept as `cause` so
      // a developer debugging a real gateway response can still see it.
      throw new Error("Failed to parse payment required header: invalid format", {
        cause: error,
      });
    }
    throw new Error("Failed to parse payment required header", { cause: error });
  }
}

/**
 * Extract payment details from parsed payment required response.
 * Supports both v1 and v2 formats, with optional network preference.
 *
 * @param paymentRequired - Parsed payment required object
 * @param preferredNetwork - Optional network preference. If specified, will try
 *   to use matching network option. Defaults to first option (Base).
 *   Examples:
 *   - "eip155:8453" for Base
 *   - "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" for Solana
 */
export function extractPaymentDetails(
  paymentRequired: PaymentRequired,
  preferredNetwork?: string
): {
  amount: string;
  recipient: string;
  network: string;
  asset: string;
  scheme: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string; feePayer?: string };
  resource?: ResourceInfo;
} {
  const accepts = paymentRequired.accepts || [];
  if (accepts.length === 0) {
    throw new Error("No payment options in payment required response");
  }

  // If preferred network specified, try to find matching option
  let option = null;
  if (preferredNetwork) {
    option = accepts.find((opt) => opt.network === preferredNetwork) || null;
  }

  // Fall back to first option (always Base for backward compatibility)
  if (!option) {
    option = accepts[0];
  }

  // Handle both v1 (maxAmountRequired) and v2 (amount) formats
  const amount = option.amount || option.maxAmountRequired;
  if (!amount) {
    throw new Error("No amount found in payment requirements");
  }

  return {
    amount,
    recipient: option.payTo,
    network: option.network,
    asset: option.asset,
    scheme: option.scheme,
    maxTimeoutSeconds: option.maxTimeoutSeconds || 300,
    extra: option.extra as { name?: string; version?: string; feePayer?: string },
    resource: paymentRequired.resource,
  };
}

/**
 * Check if a network string represents Solana.
 */
export function isSolanaNetwork(network: string): boolean {
  return network.startsWith("solana:");
}

/**
 * Get list of available networks from payment required response.
 */
export function getAvailableNetworks(paymentRequired: PaymentRequired): string[] {
  return paymentRequired.accepts
    .map((opt) => opt.network)
    .filter((network): network is string => Boolean(network));
}
