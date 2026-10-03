/**
 * Solana x402 batch-settlement (metered billing) for {@link SolanaLLMClient}.
 *
 * `exact` signs one SPL transfer per call, priced at the call's CEILING (the
 * quote for `max_tokens`), and that transfer settles on-chain before the model
 * answers. `batch-settlement` opens a deposit-backed payment channel once, then
 * each call carries only a signed authorization for a ceiling. The gateway
 * serves the call, meters what it actually cost, and signs a voucher for that
 * amount — never more than the ceiling. Vouchers are redeemed on-chain in
 * batches by the gateway's worker. You pay for the tokens you used, and there
 * is one on-chain transaction for many calls instead of one per call.
 *
 * The protocol is the official `@x402/svm` `batch-settlement` client in
 * server-signed ("operator") mode. In that mode the channel's on-chain voucher
 * signer is BlockRun's operator key, which could claim up to the whole unspent
 * deposit. So this is OPT-IN, twice over:
 *   - the caller names the operator keys it trusts (`operators`). A 402 that
 *     asks for any other operator is never paid in batch mode;
 *   - the caller caps the total escrow locked in the channel (`maxDeposit`).
 *     That cap is the most a dishonest operator could ever take.
 *
 * Before anything is sent, everything here fails OPEN to `exact`: a missing
 * batch accept, an untrusted operator, a deposit over the cap, a channel that
 * is busy with another request, or a channel the SDK is unsure about all pay
 * the same request with the `exact` scheme instead.
 *
 * Once a batch payment is sent, one function decides what its answer proves
 * (`SolanaBatchPayer.sendOnce`): charged, not charged, or in doubt. Only the
 * gateway's explicit answer to a FIRST send proves "not charged" (a 402, a
 * recognised refusal, a failed receipt proving nothing was broadcast); then
 * the call may pay again, with exact or, after a 429, with a new batch
 * payment from a fresh 402. Everything else is in doubt: an exception after
 * the send started, a 5xx or receipt-less 429, an ambiguous receipt, and any
 * answer to a replay other than a success receipt. A payment in doubt is
 * never replaced (no new authorization, no new deposit, no exact, no fallback
 * model): a receipt-less 429 gets one byte-identical replay after its
 * backoff, and anything short of a success receipt on it raises
 * {@link BatchPaymentUnresolvedError}. Resolving doubt automatically needs
 * the gateway's help (a receipt on every response, a request-status
 * endpoint); `resolveInDoubt` is where such evidence will plug in.
 *
 * A 429 that provably charged nothing is not a reason to give up on batch:
 * the gateway (or the facilitator behind it) is shedding load, and paying
 * exact would not stop the next call from sending another channel open into
 * the same limit. The call waits out `Retry-After` (or an exponential
 * backoff), and so does every other call for the wallet, then tries again.
 * Every fallback, backoff, recovery and raise is logged, counted and handed
 * to `batch.onEvent`, so a batch problem is never silent.
 *
 * Only non-streaming chat completions use it. Streamed responses commit their
 * charge after the headers are sent, so they carry no `PAYMENT-RESPONSE`
 * receipt for the client to reconcile against, and media jobs are charged on a
 * later poll. Both keep paying with `exact`.
 */
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import bs58 from "bs58";
import { paths as corePaths } from "@blockrun/core";
import { APIError, PaymentError, withDisposition, type PaymentRequired } from "./types";
import { sanitizeErrorResponse } from "./validation";

export const BATCH_SCHEME = "batch-settlement";

/**
 * BlockRun's batch-settlement operator public key on sol.blockrun.ai.
 *
 * The production key that signs vouchers on BlockRun's Solana channels (it is
 * also the channels' receiver authorizer). Pin it in
 * `batch.operators` to let this client open channels with BlockRun:
 *
 *   new SolanaLLMClient({ batch: { operators: [BLOCKRUN_SOL_OPERATOR] } })
 *
 * It is a constant on purpose: a client must never trust the operator a 402
 * names. If the key is ever rotated, both keys are valid for an overlap
 * period, and `operators` takes a list for exactly that case.
 */
export const BLOCKRUN_SOL_OPERATOR = "5YKPQUFjw5WQqhSUkEGKNNfYYVqnRRNbpYyL71qQ1vm3";

/** Opt-in configuration for Solana batch-settlement. */
export interface SolanaBatchOptions {
  /**
   * Base58 operator public keys you trust to sign vouchers against your
   * channel. A batch accept naming any other operator is ignored, and the
   * call pays with `exact`. Required: there is no built-in default key.
   */
  operators: string[];
  /**
   * Total escrow, in USD, this client will lock in one channel (the first
   * deposit plus every top-up). This is the most an operator could take
   * without another signature from you. Accepts `"$5"`, `"5"` or `5`.
   * Default `"$1"` (the `@x402/svm` default).
   */
  maxDeposit?: string | number;
  /**
   * Where open-channel state is persisted between processes.
   * - default: `~/.blockrun/solana-batch/<wallet address>.json` (mode 0600)
   * - a path: that file
   * - `false`: in memory only. On restart the client finds its channel again
   *   by scanning the chain for it.
   */
  channelStore?: string | false;
  /**
   * How a call rides out an HTTP 429 (rate limited, or channel capacity
   * exhausted) on a batch payment before it pays with `exact`. The call waits
   * for `Retry-After` (seconds or an HTTP date), or 1s, 2s, 4s... with jitter
   * when there is none (or when it is not a finite delay of at most a day),
   * then tries again: a 429 without a receipt by replaying the identical
   * payment, one that proves nothing was broadcast with a new payment. Other
   * calls for the same wallet wait out the same cooldown instead of sending
   * new channel opens; that shared cooldown never lasts longer than
   * `maxWaitMs`.
   */
  rateLimit?: {
    /** Batch payment attempts per call, the first one included. Default 3. */
    maxAttempts?: number;
    /** Most time, in ms, one call spends waiting on 429s before it pays `exact`. Default 60000. */
    maxWaitMs?: number;
  };
  /**
   * Called for every batch fallback, 429 backoff, recovery and channel
   * re-read, in addition to the one-line log the SDK writes to stderr for each.
   * A callback that throws, or returns a promise that rejects, is logged and
   * ignored; it never affects the payment, and its promise is not awaited.
   */
  onEvent?: (event: SolanaBatchEvent) => void | PromiseLike<void>;
}

/** Default {@link SolanaBatchOptions.rateLimit}. */
export const DEFAULT_BATCH_RATE_LIMIT = { maxAttempts: 3, maxWaitMs: 60_000 } as const;

/**
 * One observable batch-settlement event.
 *
 * - `fallback`: this call pays with `exact`. `reason` says why. Only ever
 *   when no batch payment of this call can have been charged.
 * - `backoff`: this call is waiting before it retries batch, after a 429
 *   (`reason: "rate_limited"`) or because another call for the wallet hit one
 *   (`reason: "cooldown"`).
 * - `recovered`: a call that backed off was then paid with batch, or its
 *   fresh challenge after the wait was served without a payment (`reason:
 *   "served_unpaid_on_rechallenge"`: that response is the call's result, and
 *   nothing was paid).
 * - `unresolved`: this call is raised as {@link BatchPaymentUnresolvedError},
 *   not paid with `exact` or any fallback model, because a batch payment it
 *   sent may have been charged and got no definitive answer. `reason` is a
 *   {@link BatchUnresolvedReason}.
 * - `resync`: the channel was re-read from the chain because the SDK could
 *   not trust its record (a deposit with no clean answer, including a 429
 *   without a receipt, a receipt that was missing or rebuilt, or a pending
 *   deposit left by a process that died).
 *   `reason` says which; `detail` says what the chain showed.
 */
export interface SolanaBatchEvent {
  type: "fallback" | "backoff" | "recovered" | "resync" | "unresolved";
  /**
   * A short, stable code: `rate_limited`, `cooldown`, `not_offered`,
   * `channel_busy`, `untrusted_operator`, `deposit_over_cap`,
   * `channel_pending`, `peer_dependency_missing`, `payment_creation_failed`,
   * `wallet_config_conflict`, `channel_store_locked`, `payment_required`,
   * `channel_resync_pending`, `channel_resync_failed`, `channel_unreadable`,
   * `served_unpaid_on_rechallenge` (a `recovered` event), or one of the gateway's refusal codes the
   * SDK recognises (`batch_payer_not_allowed`, `batch_payer_not_admitted`,
   * `batch_admission_paused`, `batch_server_signed_only`,
   * `PAYMENT_VERIFICATION_UNAVAILABLE`). An `unresolved` event's reason is a
   * {@link BatchUnresolvedReason}. A `resync` event's reason is
   * `deposit_unanswered`, `deposit_failed`, `deposit_rate_limited`,
   * `receipt_missing`, `receipt_unreconciled` or `orphaned_deposit`.
   */
  reason: string;
  /** HTTP status of the gateway answer behind the event, when there was one. */
  status?: number;
  /** The gateway's or facilitator's error code, when it named one. */
  errorReason?: string;
  /** How long this call waits (backoff), or would have had to wait (fallback). */
  retryAfterMs?: number;
  /** Which batch payment attempt of this call the event belongs to (1-based). */
  attempt?: number;
  /** Free-text detail, such as the underlying error message. */
  detail?: string;
  /** The paying wallet's address. */
  wallet: string;
  /** When it happened, in ms since the epoch. */
  at: number;
}

/** Batch-settlement counters for one client, from {@link SolanaLLMClient.getBatchStats}. */
export interface SolanaBatchStats {
  /** Calls that paid with `exact` instead of batch. */
  fallbacks: number;
  /** {@link fallbacks}, split by {@link SolanaBatchEvent.reason}. */
  fallbacksByReason: Record<string, number>;
  /** Waits before a batch retry (own 429s and shared cooldowns). */
  backoffs: number;
  /** Batch payments sent again after a 429: a new payment, or the one replay of a receipt-less 429. */
  retries: number;
  /**
   * Calls paid with batch after at least one backoff, or served without a
   * payment by their fresh challenge after one (`served_unpaid_on_rechallenge`).
   */
  recoveries: number;
  /** Times the channel record was re-read from the chain. */
  resyncs: number;
  /**
   * Calls raised as {@link BatchPaymentUnresolvedError}: a batch payment they
   * sent may have been charged, so nothing paid for them again.
   */
  unresolved: number;
  /** {@link unresolved}, split by {@link BatchUnresolvedReason}. */
  unresolvedByReason: Record<string, number>;
}

/**
 * Why a batch payment is left in doubt; see {@link BatchPaymentUnresolvedError}.
 *
 * - `replay_unresolved`: a 429 without a receipt. Its one byte-identical
 *   replay got no definitive success receipt (a 402, `duplicate_settlement`,
 *   another 429, a 5xx, a timeout...), or `batch.rateLimit` left no room to
 *   replay it.
 * - `ambiguous_rate_limit`: a 429 whose receipt does not prove nothing was
 *   broadcast (one that says it was charged, `settlement_pending`, or one
 *   naming a transaction).
 * - `no_response`: sending it threw (a timeout, an abort, a network error),
 *   whatever the error's code: the request may have reached the gateway.
 * - `outcome_unknown`: any other answer that neither serves the call nor
 *   proves nothing was charged: a 5xx without a recognised refusal code, an
 *   unrecognised 4xx, or a non-2xx whose receipt names a transaction, says
 *   `settlement_pending`, or says it succeeded.
 */
export type BatchUnresolvedReason = "replay_unresolved" | "ambiguous_rate_limit" | "no_response" | "outcome_unknown";

/** What a batch payment carried: a channel open, a top-up of the channel, or an authorization alone. */
export type BatchPayloadKind = "open" | "top-up" | "authorization";

/**
 * A batch payment this call sent may have been charged, and never got a
 * definitive answer. Reported as an `unresolved` event with the same
 * `reason` (see {@link BatchUnresolvedReason}).
 *
 * A {@link PaymentError} whose {@link RetryDisposition} is
 * `"paid-or-in-doubt"`, never transient: the SDK does not pay for the call
 * again, not with `exact`, not with a new batch payment, and not by moving
 * on to `fallbackModels` (including the chain `smartChat()` fills in). Any
 * retry is yours to make, and it is a new payment.
 *
 * When it carried a deposit (`payloadKind` `open` or `top-up`), the deposit
 * is in doubt too: the SDK signs no other deposit for that wallet's channels
 * until a chain read at `finalized` commitment settles it.
 */
export class BatchPaymentUnresolvedError extends PaymentError {
  /** The {@link SolanaBatchEvent.reason} of the `unresolved` event reported with it. */
  readonly reason: BatchUnresolvedReason;
  /** The paying wallet's address. */
  readonly wallet: string;
  /** The request id of the payment that may have been charged. */
  readonly requestId?: string;
  /** The channel it paid into. */
  readonly channelId?: string;
  /** What it carried. */
  readonly payloadKind?: BatchPayloadKind;
  /** HTTP status of the gateway's last answer to it, when there was one. */
  readonly status?: number;
  /** Whether it carried a deposit, which is now in doubt as well. */
  readonly depositInDoubt: boolean;

  constructor(init: {
    reason: BatchUnresolvedReason;
    wallet: string;
    requestId?: string;
    channelId?: string;
    payloadKind?: BatchPayloadKind;
    status?: number;
    detail?: string;
    cause?: unknown;
  }) {
    super(
      `batch-settlement payment ${init.requestId ?? "<unknown>"} from wallet ${init.wallet} may have been charged ` +
        `and is not paid again${init.detail ? `: ${init.detail}` : ""}`,
    );
    this.name = "BatchPaymentUnresolvedError";
    withDisposition(this, "paid-or-in-doubt");
    this.reason = init.reason;
    this.wallet = init.wallet;
    this.requestId = init.requestId;
    this.channelId = init.channelId;
    this.payloadKind = init.payloadKind;
    this.status = init.status;
    this.depositInDoubt = init.payloadKind === "open" || init.payloadKind === "top-up";
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }
}

/**
 * The outcome of one batch attempt.
 *
 * - `paid`: served, and paid with batch.
 * - `fallback`: pay `exact`. One after a 429 wait carries the fresh 402 it
 *   fetched, which the `exact` payment must be signed against.
 * - `served`: the fresh, unpaid challenge sent after a wait was answered with
 *   a 2xx. That response is the call's result; nothing was paid, and nothing
 *   must be.
 * - `failed`: that fresh challenge got neither a 402 nor a 2xx (or no answer,
 *   or a 402 that cannot be read). Raise `error`, which carries the `"unpaid"`
 *   retry disposition: the 429 waited out proved nothing was charged, so
 *   nothing was paid for the call. Never pay `exact` against the stale
 *   challenge instead.
 */
export type BatchAttempt =
  | { kind: "paid"; response: Response; chargedUsd: number }
  | { kind: "fallback"; reason: string; paymentRequired?: PaymentRequired }
  | { kind: "served"; response: Response }
  | { kind: "failed"; error: unknown };

/**
 * The answer to a fresh, unpaid challenge request (see
 * {@link SolanaBatchPayer.pay}): a 402 to pay, or a 2xx that served the
 * request without a payment. Anything else is thrown.
 */
export type Rechallenge =
  | { kind: "challenge"; paymentRequired: PaymentRequired }
  | { kind: "served"; response: Response };

/** Structural slice of `@x402/core`'s x402HTTPClient that this module uses. */
interface HttpPaymentClient {
  getPaymentSettleResponse(getHeader: (name: string) => string | null | undefined): SettleResponseLike;
  createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayloadLike>;
  encodePaymentSignatureHeader(payload: PaymentPayloadLike): Record<string, string>;
  processPaymentResult(
    payload: PaymentPayloadLike,
    getHeader: (name: string) => string | null | undefined,
    status: number,
  ): Promise<{ recovered: boolean; settleResponse?: SettleResponseLike }>;
}
interface SettleResponseLike {
  success?: boolean;
  amount?: string;
  transaction?: string;
  errorReason?: string;
  extra?: { chargedAmount?: unknown };
}
interface PaymentPayloadLike {
  x402Version: number;
  payload?: {
    type?: string;
    authorization?: { channelId?: string; expiresAt?: number; requestId?: string };
    voucher?: { channelId?: string };
    deposit?: { amount?: string; transaction?: string };
  };
  accepted?: { amount?: string };
}
interface StoredRecord {
  channelConfig: {
    voucherSigner?: string;
    payerAuthorizer?: string;
    token?: string;
    receiver?: string;
    receiverAuthorizer?: string;
    withdrawDelay?: number;
  };
  channelId?: string;
  chargedCumulativeAmount?: string;
  deposit?: string;
  hasConfirmedState?: boolean;
  pending?: unknown;
  [key: string]: unknown;
}
interface ChannelStorage {
  get(key: string): Promise<StoredRecord | undefined>;
  set(key: string, record: StoredRecord): Promise<void>;
  delete(key: string): Promise<void>;
}
/** A wallet's own channel store: the file, or memory with `channelStore: false`. */
interface OwnedChannelStorage extends ChannelStorage {
  clear(): void;
}
interface BuiltClient {
  http: HttpPaymentClient;
  refund: (url: string) => Promise<unknown>;
}

const INSTALL_HINT = "npm install @x402/core@~2.28.0 @x402/svm@~2.28.0 @solana/kit";

async function load<T>(pkg: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (err) {
    throw new Error(
      `@blockrun/llm: Solana batch-settlement requires the optional peer dependency "${pkg}", ` +
        `which is not installed.\n\n  ${INSTALL_HINT}\n\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * JSON-file channel storage: one file per wallet, written atomically, 0600.
 *
 * Records can hold signed, not-yet-acknowledged payment payloads, so the file
 * is private to the user like the wallet key beside it.
 */
export class FileChannelStorage implements ChannelStorage {
  constructor(private readonly file: string) {}

  private read(): Record<string, StoredRecord> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, StoredRecord>)
        : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  private write(all: Record<string, StoredRecord>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async get(key: string): Promise<StoredRecord | undefined> {
    return this.read()[key];
  }

  async set(key: string, record: StoredRecord): Promise<void> {
    const all = this.read();
    all[key] = record;
    this.write(all);
  }

  async delete(key: string): Promise<void> {
    const all = this.read();
    if (!(key in all)) return;
    delete all[key];
    this.write(all);
  }

  /** Forget every channel in this file. */
  clear(): void {
    try {
      fs.unlinkSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * In-memory channel storage for `channelStore: false`.
 *
 * The scheme is given a store even then, so the SDK can repair a record from
 * the chain and rebuild the scheme without losing the channel. Records are
 * copied in and out, as the file store does by serializing them.
 */
export class MemoryChannelStorage implements OwnedChannelStorage {
  private readonly records = new Map<string, string>();

  async get(key: string): Promise<StoredRecord | undefined> {
    const raw = this.records.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as StoredRecord);
  }

  async set(key: string, record: StoredRecord): Promise<void> {
    this.records.set(key, JSON.stringify(record));
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * A deposit (channel open or top-up) this wallet has sent, or is about to
 * send, and has not reconciled: what is needed to settle it from the chain
 * after a restart. It holds no signed bytes: nothing is ever re-sent from it.
 */
export interface DepositIntent {
  /** The scheme's storage key for the channel. */
  key: string;
  channelId: string;
  channelConfig: StoredRecord["channelConfig"];
  /** The request id of the payment that carried it. */
  requestId?: string;
  kind: "open" | "top-up";
  /** The confirmed cumulative charge, in atomic units. */
  cumulative: string;
  /** The channel's total deposit if it landed, in atomic units. */
  expectDeposit: string;
  /** The deposit the record claimed before it (top-ups), in atomic units. */
  knownDeposit?: string;
  /** See {@link ResyncTarget.anchorHeight}. */
  anchorHeight?: number;
  /** When it was journaled (ms since the epoch). */
  at: number;
}

/** Where a wallet's deposit intents are kept. */
interface IntentJournal {
  /** Whether an intent survives this process crashing. */
  readonly durable: boolean;
  list(): DepositIntent[];
  /** Record an intent; durable once this returns, when the journal is. */
  put(intent: DepositIntent): void;
  remove(key: string): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What is wrong with a journaled intent stored under `key`, or undefined when it is well-formed. */
function intentProblem(key: string, intent: unknown): string | undefined {
  const atomic = (value: unknown) => typeof value === "string" && /^\d+$/.test(value);
  if (!isPlainObject(intent)) return "not an object";
  if (intent.key !== key || !key) return "key does not match its entry";
  if (typeof intent.channelId !== "string" || !intent.channelId) return "channelId missing";
  if (!isPlainObject(intent.channelConfig)) return "channelConfig missing";
  if (intent.kind !== "open" && intent.kind !== "top-up") return "kind is neither open nor top-up";
  if (!atomic(intent.cumulative)) return "cumulative is not an atomic amount";
  if (!atomic(intent.expectDeposit)) return "expectDeposit is not an atomic amount";
  if (intent.knownDeposit !== undefined && !atomic(intent.knownDeposit)) return "knownDeposit is not an atomic amount";
  if (intent.requestId !== undefined && typeof intent.requestId !== "string") return "requestId is not a string";
  if (intent.anchorHeight !== undefined && (!Number.isSafeInteger(intent.anchorHeight) || (intent.anchorHeight as number) < 0)) {
    return "anchorHeight is not a block height";
  }
  if (typeof intent.at !== "number" || !Number.isFinite(intent.at)) return "at is not a time";
  return undefined;
}

/** Fsync a directory so a rename or unlink in it is durable, where the platform allows it. */
function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (err) {
    // Windows cannot open a directory, and some filesystems refuse to fsync one.
    const code = (err as NodeJS.ErrnoException).code;
    if (!["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EBADF"].includes(code ?? "")) throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The write-ahead journal of deposits in doubt, beside the channel file:
 * `<store>.deposit-intents` (the store's full path plus a suffix, so each
 * store has its own), mode 0600.
 *
 * A deposit's intent is written, and the file and its directory fsynced,
 * BEFORE the deposit is sent, and removed only once the deposit is
 * reconciled (a receipt the scheme verified, a refusal proving nothing was
 * broadcast, or a finalized chain read). After a crash, every intent left
 * here becomes a deposit in doubt: no deposit is signed for the wallet until
 * the chain settles it, and nothing is paid again for the request that
 * carried it.
 */
export class FileIntentJournal implements IntentJournal {
  readonly durable = true;

  constructor(readonly file: string) {}

  /** The journal file for a channel store file: its full path plus `.deposit-intents`, one per store. */
  static beside(channelFile: string): FileIntentJournal {
    return new FileIntentJournal(`${channelFile}.deposit-intents`);
  }

  /**
   * Where earlier builds kept a store's journal: the store's name without
   * `.json`, plus `.deposit-intents.json`. Two stores could share it
   * (`/x/channels` and `/x/channels.json`), so its intents are moved by payer
   * ({@link adoptLegacy}). No current journal path ever ends in `.json`, so
   * this never names one.
   */
  static legacyBeside(channelFile: string): string {
    const base = path.basename(channelFile).replace(/\.json$/i, "");
    return path.join(path.dirname(channelFile), `${base}.deposit-intents.json`);
  }

  /**
   * Move `payer`'s intents from a journal an earlier build wrote at
   * `legacyFile` into this one, before this one is used: written here first
   * (durably), then removed there (the file goes once empty). Intents of other
   * payers are left where they are, for the store they belong to. An intent
   * already here is kept (a migration interrupted between the two writes).
   *
   * @throws when the old journal cannot be read or is not valid, or holds an
   *   intent naming no payer: the wallet then keeps batch off, as for an
   *   unreadable journal, and nothing is dropped.
   */
  adoptLegacy(legacyFile: string, payer: string): void {
    if (legacyFile === this.file) return;
    const legacy = new FileIntentJournal(legacyFile);
    const found = legacy.read();
    const mine: DepositIntent[] = [];
    const others: Record<string, DepositIntent> = {};
    for (const [key, intent] of Object.entries(found)) {
      const owner = (intent.channelConfig as { payer?: unknown }).payer;
      if (typeof owner !== "string") {
        throw new Error(`deposit-intent journal ${legacyFile} holds an intent naming no payer (${JSON.stringify(key)}); move it by hand`);
      }
      if (owner === payer) mine.push(intent);
      else others[key] = intent;
    }
    if (mine.length === 0) return;
    const intents = this.read();
    for (const intent of mine) intents[intent.key] ??= intent;
    this.write(intents);
    legacy.write(others);
  }

  /**
   * The journaled intents. Only a missing file is an empty journal: anything
   * else that is not a version-1 journal of well-formed intents throws, so a
   * deposit in doubt is never lost to a damaged or unknown file (the wallet
   * then keeps batch off, `deposit_journal_unreadable`).
   */
  private read(): Record<string, DepositIntent> {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const invalid = (why: string) => new Error(`deposit-intent journal ${this.file} is not valid (${why})`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw invalid(err instanceof Error ? err.message : String(err));
    }
    if (!isPlainObject(parsed)) throw invalid("not a JSON object");
    if (parsed.version !== 1) throw invalid(`unsupported version ${JSON.stringify(parsed.version)}`);
    const { intents } = parsed;
    if (!isPlainObject(intents)) throw invalid("intents is not an object");
    for (const [key, intent] of Object.entries(intents)) {
      const why = intentProblem(key, intent);
      if (why) throw invalid(`intent ${JSON.stringify(key)}: ${why}`);
    }
    return intents as Record<string, DepositIntent>;
  }

  private write(intents: Record<string, DepositIntent>): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (Object.keys(intents).length === 0) {
      try {
        fs.unlinkSync(this.file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return;
      }
      fsyncDirectory(dir);
      return;
    }
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ version: 1, intents }, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    fsyncDirectory(dir);
  }

  list(): DepositIntent[] {
    return Object.values(this.read());
  }

  put(intent: DepositIntent): void {
    const intents = this.read();
    intents[intent.key] = intent;
    this.write(intents);
  }

  remove(key: string): void {
    const intents = this.read();
    if (!(key in intents)) return;
    delete intents[key];
    this.write(intents);
  }
}

/**
 * The deposit-intent journal for `channelStore: false`: memory only. A crash
 * loses it, so crash recovery of a deposit in doubt is not available in that
 * mode (the channel is found again on-chain, but a deposit that was in
 * flight is not known to be in doubt).
 */
export class MemoryIntentJournal implements IntentJournal {
  readonly durable = false;
  private readonly intents = new Map<string, DepositIntent>();

  list(): DepositIntent[] {
    return [...this.intents.values()];
  }

  put(intent: DepositIntent): void {
    this.intents.set(intent.key, { ...intent });
  }

  remove(key: string): void {
    this.intents.delete(key);
  }
}

/** Whether a process with this pid is running. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Batch state for the whole process, shared by every loaded copy of this
 * module (the CJS and ESM builds side by side, or two installs of the
 * package) through `globalThis` under a versioned `Symbol.for` key.
 *
 * Per-copy maps were a real bug: two copies in one process share a pid but
 * not their state, so the second copy took the first copy's live channel-file
 * lock for a stale one, unlinked it, and built a second scheme over the same
 * channel. Both could then open a channel, or top one up from the same
 * balance, and each passed the `maxDeposit` check on its own. With one
 * registry every copy sees the same wallets (one scheme, one in-flight flag,
 * one channel book per wallet) and the same held locks.
 *
 * Bump the version when the shape of {@link WalletBatch} or of this registry
 * changes: copies with different versions then keep separate registries, and
 * a copy never mistakes another version's lock for a stale one (see
 * {@link lockChannelFile}), so they cannot share a channel file at all.
 */
const BATCH_REGISTRY = Symbol.for("@blockrun/llm/batch-registry/v1");
interface BatchRegistry {
  /** Batch state per wallet address. */
  wallets: Map<string, WalletBatch>;
  /** Channel files whose lock this process holds, with the lock's ownership token. */
  locks: Map<string, string>;
  /** Whether the exit hook that removes held locks is installed. */
  exitHook: boolean;
}
const registryHost = globalThis as typeof globalThis & { [BATCH_REGISTRY]?: BatchRegistry };
const registry: BatchRegistry = (registryHost[BATCH_REGISTRY] ??= {
  wallets: new Map(),
  locks: new Map(),
  exitHook: false,
});

/**
 * The sidecar beside a lock file that holds its owner's random ownership
 * token. The lock file itself holds only the owner's bare pid, exactly what
 * released versions (3.19.x) write and read with `Number(raw.trim())`: a lock
 * in any other format reads as `NaN` to them, so they would take a live lock
 * for a stale one, remove it, and two processes could each top up past
 * `maxDeposit`. They never look at this file.
 */
function lockTokenFile(lock: string): string {
  return `${lock}.owner`;
}

/** A lock file's owner pid (0 when it names none), and its raw content. */
function readLockOwner(lock: string): { pid: number; raw: string } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(lock, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let pid = Number(raw.trim());
  if (!Number.isInteger(pid)) {
    // A pre-release build of this branch wrote `{pid, token}` into the lock itself.
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      pid = parsed && typeof parsed === "object" && Number.isInteger(parsed.pid) ? (parsed.pid as number) : 0;
    } catch {
      pid = 0;
    }
  }
  return { pid, raw };
}

/** The ownership token in a lock's sidecar, if it has a readable one. */
function readLockToken(lock: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockTokenFile(lock), "utf8")) as { token?: unknown };
    return parsed && typeof parsed === "object" && typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a lock file is still this process's, taken with `token`. */
function ownsLock(lock: string, token: string): boolean {
  return readLockOwner(lock)?.pid === process.pid && readLockToken(lock) === token;
}

/** Remove the lock files this process holds (and their sidecars), if they are still ours. */
function releaseHeldLocks(): void {
  for (const [file, token] of registry.locks) {
    const lock = `${file}.lock`;
    try {
      if (!ownsLock(lock, token)) continue;
      fs.unlinkSync(lock);
      fs.unlinkSync(lockTokenFile(lock));
    } catch { /* already gone */ }
  }
}

/**
 * Take exclusive ownership of a channel file for this process.
 *
 * Two owners of one channel file each keep their own view of the deposit, so
 * each tops up from a stale balance and together they can lock more than
 * `maxDeposit`, or open two channels. One process owns the file. The lock
 * file holds the owner's bare pid, the format released versions read, and is
 * created whole (written to a temporary file, then hard-linked into place,
 * which fails if a lock exists), so a reader never sees a half-written one.
 * The owner's random ownership token goes in a sidecar ({@link
 * lockTokenFile}), written once the lock is taken, so a release only ever
 * removes a lock this very owner took.
 *
 * Only a lock whose process is gone is taken over. A lock that names this
 * process but is not in the process-wide registry was taken by another copy
 * of the SDK in this process (one with a different registry version), so it
 * is in use, never stale.
 *
 * @returns undefined when the lock is ours, or the live owner's pid (this
 *   process's own pid when another SDK copy in it holds the file).
 */
export function lockChannelFile(file: string): number | undefined {
  if (registry.locks.has(file)) return undefined;
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tmp = `${lock}.${process.pid}.${token}.tmp`;
    try {
      fs.writeFileSync(tmp, String(process.pid), { mode: 0o600 });
      fs.linkSync(tmp, lock);
      try {
        writeLockToken(lock, token);
      } catch (err) {
        // Without its token the lock could never be released safely: give it up.
        try { fs.unlinkSync(lock); } catch { /* already gone */ }
        throw err;
      }
      registry.locks.set(file, token);
      if (!registry.exitHook) {
        registry.exitHook = true;
        process.once("exit", releaseHeldLocks);
      }
      return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* not created */ }
    }
    const owner = readLockOwner(lock);
    if (!owner) continue; // released meanwhile: try again
    // Never stale while this process is alive: another SDK copy in it holds it.
    if (owner.pid === process.pid) return process.pid;
    if (owner.pid > 0 && processAlive(owner.pid)) return owner.pid;
    // Its process is gone. Remove it only if it is still the lock judged stale.
    try {
      if (readLockOwner(lock)?.raw === owner.raw) fs.unlinkSync(lock);
    } catch { /* raced with another taker */ }
  }
  return -1;
}

/** Write a lock's ownership-token sidecar whole (temporary file, then rename), mode 0600. */
function writeLockToken(lock: string, token: string): void {
  const sidecar = lockTokenFile(lock);
  const tmp = `${sidecar}.${process.pid}.${token}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    fs.renameSync(tmp, sidecar);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed */ }
  }
}

/** True when a stored pending entry was a channel open or top-up. */
function pendingDeposit(pending: unknown): boolean {
  const entries = Array.isArray(pending) ? pending : [pending];
  return entries.some(
    (entry) => (entry as { payment?: { payload?: { type?: string } } })?.payment?.payload?.type === "deposit",
  );
}

/**
 * A channel record the SDK must re-read from the chain before anything pays
 * into it again: what it knew, and why it stopped trusting it. While any is
 * pending, the wallet signs no batch payment at all, so no other deposit
 * can land on a channel whose deposit is in doubt.
 */
interface ResyncTarget {
  key: string;
  channelId: string;
  channelConfig: StoredRecord["channelConfig"];
  /** The cumulative charge the SDK can vouch for; the chain's settled amount wins when higher. */
  cumulative: bigint;
  /**
   * For a deposit in doubt: the channel's total deposit if it landed. A
   * channel short of it is not adopted while the deposit may still land.
   */
  expectDeposit?: bigint;
  /**
   * The deposit the SDK's record claimed (its confirmed state), which a
   * finalized read showing less does not override while a recent deposit
   * may simply not be finalized yet.
   */
  knownDeposit?: bigint;
  /**
   * A block height read (at `confirmed`) after the payment was built: an
   * upper bound on its transaction's blockhash height, so once the
   * finalized chain is {@link LANDING_MARGIN_BLOCKS} past it, that
   * transaction can never land. Taken on the first re-read.
   */
  anchorHeight?: number;
  reason:
    | "deposit_unanswered"
    | "deposit_failed"
    | "deposit_rate_limited"
    | "receipt_missing"
    | "receipt_unreconciled"
    | "orphaned_deposit";
}

/** Thrown into the scheme when a stored record needs a chain re-read before it can be used. */
export class ChannelResyncRequiredError extends Error {
  constructor(readonly channelId: string | undefined) {
    super(`batch-settlement channel ${channelId ?? "<unknown>"} needs a chain re-read before it is used`);
    this.name = "ChannelResyncRequiredError";
  }
}

/**
 * A {@link ChannelResyncRequiredError}, matched by name: the channel book is
 * shared by every SDK copy in the process, so the error can come from
 * another copy's class.
 */
function isResyncRequired(err: unknown): boolean {
  return err instanceof Error && err.name === "ChannelResyncRequiredError";
}

function parseAtomic(value: unknown): bigint {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

/**
 * The cumulative charge a stored record has confirmed for a channel: zero for
 * a record of another channel, or one that was never confirmed.
 */
function confirmedCumulative(record: StoredRecord | undefined, channelId: string): bigint {
  if (!record || record.channelId !== channelId) return 0n;
  return record.pending === undefined || record.hasConfirmedState ? parseAtomic(record.chargedCumulativeAmount) : 0n;
}

/**
 * The scheme's view of a wallet's channel store.
 *
 * It remembers the last record it saw for each key, including ones the scheme
 * has since deleted, so the SDK can still name the channel (and the last
 * cumulative it confirmed) when a deposit went wrong and the scheme dropped
 * its record.
 *
 * It also keeps a request that a dead process never heard back about from
 * wedging the channel. In server-signed mode the scheme refuses a new request
 * while one is pending, and a pending entry is only cleared by that request's
 * response. The channel file is owned by one live process at a time
 * ({@link lockChannelFile}), and that process tracks its own requests in
 * memory, so a pending entry read from storage belongs to a process that is
 * gone.
 *
 * - A pending authorization is dropped and the confirmed state kept. That can
 *   only under-count what was charged, which the next voucher corrects.
 * - A pending DEPOSIT (open or top-up), or a record that was never confirmed,
 *   is NOT deleted and NOT handed to the scheme. The gateway funds a deposit
 *   before it serves anything, so the channel may hold more than the record
 *   says, or exist when the record says it was never confirmed. Deleting the
 *   record would make the scheme open a second channel whenever its on-chain
 *   scan comes back empty; using it could top up past `maxDeposit`. Instead
 *   the read fails with {@link ChannelResyncRequiredError} and the SDK re-reads
 *   that channel from the chain, then rewrites the record from what it finds.
 */
export class ChannelBook implements ChannelStorage {
  private readonly seen = new Map<string, StoredRecord>();

  constructor(
    readonly base: ChannelStorage & Partial<Pick<OwnedChannelStorage, "clear">>,
    private readonly onUnverified: (target: ResyncTarget) => void = () => {},
  ) {}

  async get(key: string): Promise<StoredRecord | undefined> {
    const record = await this.base.get(key);
    if (record) this.seen.set(key, record);
    if (!record?.pending || record.channelConfig?.voucherSigner !== "server") return record;
    if (record.hasConfirmedState && !pendingDeposit(record.pending)) {
      const { pending: _pending, hasConfirmedState: _confirmed, ...confirmed } = record;
      await this.set(key, confirmed as StoredRecord);
      return confirmed as StoredRecord;
    }
    if (typeof record.channelId === "string") {
      const pendingEntries = (Array.isArray(record.pending) ? record.pending : [record.pending]) as Array<{
        deposit?: unknown;
        payment?: { payload?: { type?: string } };
      }>;
      const inDoubt = pendingEntries.find((entry) => entry?.payment?.payload?.type === "deposit");
      this.onUnverified({
        key,
        channelId: record.channelId,
        channelConfig: record.channelConfig,
        cumulative: record.hasConfirmedState ? parseAtomic(record.chargedCumulativeAmount) : 0n,
        ...(record.hasConfirmedState ? { knownDeposit: parseAtomic(record.deposit) } : {}),
        ...(inDoubt ? { expectDeposit: parseAtomic(inDoubt.deposit) } : {}),
        reason: "orphaned_deposit",
      });
    }
    throw new ChannelResyncRequiredError(record.channelId);
  }

  /**
   * Store a record, and only once it is stored remember it as the last one
   * seen. If storing fails (say, while the scheme saves a reconciled
   * receipt), the scheme reports the receipt unreconciled, and the SDK must
   * still see the state from before it: `distrust()` adds that call's charge
   * to it, and a remembered post-receipt cumulative would count it twice.
   */
  async set(key: string, record: StoredRecord): Promise<void> {
    await this.base.set(key, record);
    this.seen.set(key, record);
  }

  async delete(key: string): Promise<void> {
    await this.base.delete(key);
  }

  /** The last record seen for a channel, even one the scheme has deleted since. */
  find(channelId: string): { key: string; record: StoredRecord } | undefined {
    for (const [key, record] of this.seen) {
      if (record.channelId === channelId) return { key, record };
    }
    return undefined;
  }

  clear(): void {
    this.seen.clear();
    this.base.clear?.();
  }
}

/**
 * Wrap storage so a request a dead process never heard back about cannot
 * wedge the channel, and a deposit it never heard back about is re-read from
 * the chain rather than trusted or deleted. See {@link ChannelBook}.
 */
export function dropOrphanedPending(
  storage: ChannelStorage,
  onUnverified?: (target: ResyncTarget) => void,
): ChannelBook {
  return new ChannelBook(storage, onUnverified);
}

/**
 * The payment-channels program that owns every batch-settlement channel
 * account (`PAYMENT_CHANNELS_PROGRAM_ID` in `@x402/svm`, which does not
 * export it).
 */
const PAYMENT_CHANNELS_PROGRAM_ID = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX";

/**
 * Byte layout of a channel account, as `@x402/svm` 2.28 decodes it:
 * discriminator u8, version u8, bump u8, status u8, salt u64, deposit u64,
 * settled u64, payoutWatermark u64, closureStartedAt i64, payerWithdrawnAt
 * i64, gracePeriod u32, distributionHash [32], payer, payee,
 * authorizedSigner, mint, rentPayer (32 bytes each), openSlot u64. The size
 * and rent-payer offset are checked against the constants `@x402/svm` does
 * export before the layout is trusted.
 */
const CHANNEL = {
  size: 256,
  rentPayer: 216,
  discriminator: 1,
  status: 3,
  deposit: 12,
  settled: 20,
  closureStartedAt: 36,
  payer: 88,
  authorizedSigner: 152,
  mint: 184,
} as const;

/** What the SDK reads back from a channel account. */
export interface OnChainChannel {
  deposit: bigint;
  settled: bigint;
  /** Open and not closing. */
  open: boolean;
  payer: string;
  authorizedSigner: string;
  mint: string;
}

/** Decode a channel account; undefined when it is not one. */
export function decodeChannelAccount(owner: unknown, data: Uint8Array): OnChainChannel | undefined {
  if (owner !== PAYMENT_CHANNELS_PROGRAM_ID || data.length < CHANNEL.size || data[0] !== CHANNEL.discriminator) {
    return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (offset: number) => bs58.encode(data.subarray(offset, offset + 32));
  return {
    deposit: view.getBigUint64(CHANNEL.deposit, true),
    settled: view.getBigUint64(CHANNEL.settled, true),
    open: data[CHANNEL.status] === 0 && view.getBigInt64(CHANNEL.closureStartedAt, true) === 0n,
    payer: key(CHANNEL.payer),
    authorizedSigner: key(CHANNEL.authorizedSigner),
    mint: key(CHANNEL.mint),
  };
}

/**
 * A non-null account at a channel's address that cannot be read as this
 * program's channel. Only an absent account (`value: null`) means "no
 * channel"; this must never be taken for one.
 */
export class ChannelUnreadableError extends Error {
  constructor(channelId: string, why: string) {
    super(`account ${channelId} is on chain but is not a readable payment channel (${why})`);
    this.name = "ChannelUnreadableError";
  }
}

/**
 * `@x402/svm`'s payment-channel account layout is not the one this SDK
 * decodes (or could not be checked). Decoding with stale offsets would read
 * the wrong `deposit` and `settled`, so no channel account is decoded at all.
 */
export class ChannelLayoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChannelLayoutError";
  }
}

/**
 * Read one channel account from the chain, at `finalized` commitment: the
 * SDK settles deposits in doubt only from state no fork can take back. Every
 * read first checks that `@x402/svm`'s channel layout is the one decoded
 * here.
 *
 * @param options.minContextSlot - refuse an answer from a node that has not
 *   reached this slot (the RPC errors instead).
 * @returns the channel, or undefined only when the RPC reports no account
 *   there (`value: null`).
 * @throws ChannelLayoutError (before any request) when `@x402/svm`'s
 *   channel layout is not the one decoded here; an error when the RPC cannot
 *   answer; or ChannelUnreadableError when an account exists but cannot be
 *   decoded as this program's channel (wrong owner, layout, or encoding).
 *   None is ever mistaken for "no channel", which would let the scheme open
 *   a second one.
 */
export async function readChannelAccount(
  rpcUrl: string,
  channelId: string,
  rpcHeaders?: Record<string, string>,
  options: { minContextSlot?: number } = {},
): Promise<OnChainChannel | undefined> {
  await checkChannelLayout();
  const config: Record<string, unknown> = { encoding: "base64", commitment: "finalized" };
  if (options.minContextSlot !== undefined) config.minContextSlot = options.minContextSlot;
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { ...rpcHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [channelId, config] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`getAccountInfo answered HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: { value?: { owner?: unknown; data?: unknown } | null } | null;
    error?: { message?: string };
  };
  if (body.error) throw new Error(`getAccountInfo failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  if (!body.result || typeof body.result !== "object" || !("value" in body.result)) {
    throw new Error("getAccountInfo returned no result");
  }
  const value = body.result.value;
  if (value === null) return undefined;
  if (!value || typeof value !== "object") throw new ChannelUnreadableError(channelId, "malformed account value");
  if (!Array.isArray(value.data) || typeof value.data[0] !== "string" || value.data[1] !== "base64") {
    throw new ChannelUnreadableError(channelId, "unsupported data encoding");
  }
  const channel = decodeChannelAccount(value.owner, Buffer.from(value.data[0], "base64"));
  if (!channel) throw new ChannelUnreadableError(channelId, "wrong owner or layout");
  return channel;
}

/** One JSON-RPC call; throws on any error, so a failed read is never taken for an answer. */
async function rpcRequest(
  rpcUrl: string,
  method: string,
  params: unknown[],
  rpcHeaders?: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { ...rpcHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${method} answered HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  if (body.result === undefined || body.result === null) throw new Error(`${method} returned no result`);
  return body.result;
}

/** A non-negative integer from an RPC answer, or a throw. */
function rpcInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${what} is not a block height or slot`);
  return value;
}

let layoutChecked: Promise<void> | undefined;

/**
 * Refuse to decode channel accounts if `@x402/svm` changed their layout:
 * its exported account size and rent-payer offset must match
 * {@link CHANNEL}. {@link readChannelAccount} runs it before every read. A
 * pass is cached; a failure is not, so it is checked again next time.
 *
 * @throws ChannelLayoutError
 */
function checkChannelLayout(): Promise<void> {
  layoutChecked ??= (async () => {
    const svm = await load("@x402/svm", () => import("@x402/svm")).catch((err: unknown) => {
      throw new ChannelLayoutError(
        `cannot check the payment-channel account layout: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    });
    if (svm.CHANNEL_ACCOUNT_SIZE !== BigInt(CHANNEL.size) || svm.CHANNEL_RENT_PAYER_OFFSET !== BigInt(CHANNEL.rentPayer)) {
      throw new ChannelLayoutError("@x402/svm changed the payment-channel account layout; this SDK cannot read channels from it");
    }
  })();
  layoutChecked.catch(() => { layoutChecked = undefined; });
  return layoutChecked;
}

/**
 * How far, in blocks, the finalized chain must be past a deposit's anchor
 * height before a finalized read that does not show the deposit proves it
 * never landed.
 *
 * A transaction is valid for 150 blocks past its blockhash's height
 * (`lastValidBlockHeight`), and the anchor, a block height the SDK read
 * itself after the payment was built, bounds that height from above. Never
 * the 402's own `lastValidBlockHeight`, which a hostile 402 could set to 0;
 * never wall-clock time, which a halted cluster does not respect. The other
 * 150 blocks absorb an RPC that lags behind the one the gateway used.
 * Once the finalized chain is past it, no fork can still include the
 * transaction, and any block that did is finalized and visible.
 */
const LANDING_MARGIN_BLOCKS = 300;

/** The larger of two optional amounts. */
function maxOf(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

/** Why a channel could not be re-read, as a fallback reason. */
class ResyncError extends Error {
  constructor(readonly reason: "channel_resync_pending" | "channel_resync_failed" | "channel_unreadable", message: string) {
    super(message);
    this.name = "ResyncError";
  }
}

/** The channel a payload pays into. */
function payloadChannelId(payload: PaymentPayloadLike): string | undefined {
  return payload.payload?.authorization?.channelId ?? payload.payload?.voucher?.channelId;
}

/** True when a 402 offers a batch-settlement accept. */
export function offersBatch(paymentRequired: PaymentRequired): boolean {
  return (paymentRequired.accepts ?? []).some((accept) => accept.scheme === BATCH_SCHEME);
}

/**
 * Why a 402 cannot be paid with batch at all, as a fallback event: it offers
 * no batch accept (`not_offered`). Undefined when it offers one.
 */
function batchUnavailable(paymentRequired: PaymentRequired): { reason: string; detail?: string } | undefined {
  return offersBatch(paymentRequired) ? undefined : { reason: "not_offered" };
}

/** Atomic USDC string to USD. */
function atomicToUsd(amount: unknown): number | undefined {
  return typeof amount === "string" && /^\d+$/.test(amount) ? Number(amount) / 1e6 : undefined;
}

/**
 * What one served call was charged, in USD, read from its PAYMENT-RESPONSE.
 *
 * The gateway reports the metered charge in `extra.chargedAmount`; the
 * top-level `amount` is `""` on an authorization, and only carries the charge
 * on a receipt the gateway rebuilt after confirming a commit landed (that one
 * has no `extra`). The ceiling (`accepted.amount`) is never used: it is what
 * the call could have cost, not what it did.
 *
 * Decoded straight from the header rather than taken from the scheme, so a
 * receipt the scheme refuses to reconcile is still counted.
 */
function chargedUsd(getReceipt: () => SettleResponseLike): number {
  let receipt: SettleResponseLike;
  try {
    receipt = getReceipt();
  } catch {
    return 0;
  }
  return atomicToUsd(receipt?.extra?.chargedAmount) ?? atomicToUsd(receipt?.amount) ?? 0;
}

/**
 * The charge a receipt states when the scheme could not reconcile it (the
 * gateway's rebuilt receipt carries it in `amount`), in atomic units, capped
 * at the call's ceiling. Zero when it states none.
 */
function rebuiltCharge(settled: SettleResponseLike | undefined, payload: PaymentPayloadLike): bigint {
  if (settled?.success !== true) return 0n;
  const charged = parseAtomic(typeof settled.extra?.chargedAmount === "string" ? settled.extra.chargedAmount : settled.amount);
  const ceiling = parseAtomic(payload.accepted?.amount);
  return charged > ceiling ? ceiling : charged;
}

/**
 * The gateway's refusals of a batch payment that it gives before it verifies
 * or reserves anything, so they charge nothing and the call may pay `exact`
 * instead: the payer is not admitted or allowed, admission is paused, the
 * route takes only server-signed channels, or the verifier is unreachable.
 *
 * A closed list on purpose. Any other code, including an unknown `batch_*`
 * one, is not proof that nothing was charged: the payment stays in doubt.
 */
const BATCH_REFUSALS: ReadonlySet<string> = new Set([
  "batch_payer_not_allowed",
  "batch_payer_not_admitted",
  "batch_admission_paused",
  "batch_server_signed_only",
  "PAYMENT_VERIFICATION_UNAVAILABLE",
]);

/**
 * The {@link BATCH_REFUSALS} code a 400/403/409/503 answer names in its JSON
 * body (`error` or `code`), if any.
 */
async function batchRefusal(response: Response): Promise<string | undefined> {
  if (![400, 403, 409, 503].includes(response.status)) return undefined;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return undefined;
  }
  const { error, code } = (body ?? {}) as { error?: unknown; code?: unknown };
  for (const value of [code, error]) {
    if (typeof value === "string" && BATCH_REFUSALS.has(value)) return value;
  }
  return undefined;
}

/**
 * Whether a receipt on a refused payment shows nothing was charged or
 * broadcast: none at all, or a failed one with no transaction that is not
 * `settlement_pending`. A receipt naming a transaction, `settlement_pending`,
 * or one that says it succeeded leaves the payment in doubt.
 */
function cleanRefusalReceipt(receipt: SettleResponseLike | undefined): boolean {
  if (receipt === undefined) return true;
  return receipt.success === false && !receipt.transaction && receipt.errorReason !== "settlement_pending";
}

/**
 * The gateway's error answer to a sent payment, as the `cause` of the
 * {@link BatchPaymentUnresolvedError} raised for it, so its status and body
 * stay readable.
 */
async function afterPaymentError(response: Response): Promise<APIError> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = { error: "Request failed" };
  }
  return withDisposition(
    new APIError(`API error after payment: ${response.status}`, response.status, sanitizeErrorResponse(body)),
    "paid-or-in-doubt",
  );
}

/** A short description of a receipt, for an event's `detail`. */
function describeReceipt(receipt: SettleResponseLike | undefined): string {
  if (!receipt) return "no receipt";
  const parts = [`success=${String(receipt.success)}`];
  if (receipt.errorReason) parts.push(`errorReason=${receipt.errorReason}`);
  if (receipt.transaction) parts.push(`transaction=${receipt.transaction}`);
  return `receipt ${parts.join(" ")}`;
}

/**
 * The longest `Retry-After` taken at its word (a day). A 429 asking for
 * longer is not a rate-limit delay, and is treated like no header at all.
 */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * A `Retry-After` value in ms: delay-seconds or an HTTP date. Undefined when
 * absent, unreadable, not finite (a long run of digits makes
 * `Number(text) * 1000` Infinity) or absurd (over {@link MAX_RETRY_AFTER_MS}),
 * so the caller falls back to exponential backoff.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(text)) {
    ms = Math.round(Number(text) * 1000);
  } else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - now);
  }
  return Number.isFinite(ms) && ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
}

/**
 * 429 reasons the facilitator gives before it broadcasts anything: the
 * account or channel capacity limit, and the deposit-attempt rate limit.
 */
const NOT_BROADCAST_429 = new Set([
  "batch_account_channel_capacity_exhausted",
  "batch_channel_capacity_exhausted",
  "batch_deposit_rate_limited",
]);

/**
 * Whether a 429's receipt proves the payment went nowhere: a failed receipt
 * with no transaction, for one of {@link NOT_BROADCAST_429}. Any other
 * receipt (charged, `settlement_pending`, one naming a transaction) means a
 * deposit may have been broadcast, which rolling back local state cannot undo.
 */
function provesNothingBroadcast(receipt: SettleResponseLike | undefined): boolean {
  return (
    receipt?.success === false &&
    !receipt.transaction &&
    typeof receipt.errorReason === "string" &&
    NOT_BROADCAST_429.has(receipt.errorReason)
  );
}

/** Exponential backoff with jitter for a 429 without `Retry-After`: ~1s, 2s, 4s... */
function backoffDelay(attempt: number): number {
  const base = 1000 * 2 ** Math.max(0, attempt - 1);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/**
 * The reason a 429 names, if any: the facilitator's `errorReason` (for
 * example `batch_deposit_rate_limited`), or an `error` / `code` / `reason`
 * string in the JSON body, or the receipt's `errorReason`.
 */
async function rateLimitReason(response: Response, settled: SettleResponseLike | undefined): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }
  const fields = (body ?? {}) as Record<string, unknown>;
  for (const value of [fields.errorReason, fields.error, fields.code, fields.reason, settled?.errorReason]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Why a payment payload could not be built, as a stable code plus the message. */
function creationFailure(err: unknown): { reason: string; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === "UntrustedOperatorError") return { reason: "untrusted_operator", detail };
  if (detail.includes("serverSignedChannelsPolicy maxDeposit")) return { reason: "deposit_over_cap", detail };
  if (detail.includes("has a pending request")) return { reason: "channel_pending", detail };
  if (detail.includes("requires the optional peer dependency")) return { reason: "peer_dependency_missing", detail };
  return { reason: "payment_creation_failed", detail };
}

/** A logged field value: bare when it is a simple token, JSON-quoted otherwise, so a line never breaks. */
function logValue(value: string | number): string {
  const text = String(value);
  return /^[\w.:/@+-]+$/.test(text) ? text : JSON.stringify(text);
}

/** One greppable stderr line per event: `[@blockrun/llm] batch-settlement event=... reason=... next=...`. */
function formatEvent(event: SolanaBatchEvent): string {
  const fields: Array<[string, string | number | undefined]> = [
    ["event", event.type],
    ["reason", event.reason],
    ["status", event.status],
    ["errorReason", event.errorReason],
    ["retryAfterMs", event.retryAfterMs],
    ["attempt", event.attempt],
    ["wallet", event.wallet],
    ["next", event.type === "fallback" ? "exact" : event.type === "backoff" ? "retry" : event.type === "unresolved" ? "raise" : undefined],
    ["detail", event.detail],
  ];
  const parts = fields.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${logValue(v as string | number)}`);
  return `[@blockrun/llm] batch-settlement ${parts.join(" ")}`;
}

/**
 * A batch payment this call built and sent. Every send of it carries these
 * exact headers: the same request id, the same signed authorization and, for
 * a deposit, the same signed transaction. It is never rebuilt.
 */
interface SentPayment {
  http: HttpPaymentClient;
  payload: PaymentPayloadLike;
  headers: Record<string, string>;
  kind: BatchPayloadKind;
  /** The scheme's storage key for the channel it pays into, when known. */
  key?: string;
  /** When it was first sent (ms since the epoch). */
  sentAt: number;
  /** How many times it has been sent. */
  sends: number;
  /**
   * For a deposit: the channel's total deposit if it lands, computed from
   * the record before the payment was sent (the value journaled). Never
   * recomputed afterwards: once the scheme has committed a reconciled
   * deposit, the record already includes it.
   */
  expectDeposit?: bigint;
}

/**
 * What one send of a batch payment proved. {@link SolanaBatchPayer.sendOnce}
 * is the only place an answer is classified, into exactly one of:
 *
 * - `charged`: the call was served (any 2xx on a first send; on a replay, a
 *   2xx with a success receipt only).
 * - `not_charged`: the gateway's explicit answer to a FIRST send proves
 *   nothing was charged: a 402 or a {@link BATCH_REFUSALS} code, with no
 *   receipt or a clean failed one, or a 429 whose failed receipt proves
 *   nothing was broadcast (`rateLimited`). Never from a replay.
 * - `in_doubt`: everything else, including every exception once the send
 *   started. `replayable` marks the one case allowed a replay: a 429 with
 *   no receipt, on a first send. `settled` says whether the scheme was
 *   handed the answer (and so has already released the payment).
 */
type SendOutcome =
  | { kind: "charged"; response: Response; chargedUsd: number }
  | {
      kind: "not_charged";
      reason: string;
      status: number;
      errorReason?: string;
      rateLimited?: { retryAfterMs?: number };
    }
  | InDoubt;

interface InDoubt {
  kind: "in_doubt";
  reason: BatchUnresolvedReason;
  replayable: boolean;
  settled: boolean;
  status?: number;
  errorReason?: string;
  retryAfterMs?: number;
  detail: string;
  cause?: unknown;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let sleep = realSleep;

/** Tests only: replace the backoff sleep (restored by {@link __resetBatchWalletsForTests}). */
export function __setBatchSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}

export interface SolanaBatchPayerInit {
  options: SolanaBatchOptions;
  secretKey: () => Promise<Uint8Array>;
  address: () => Promise<string>;
  rpcUrl: string;
  /** Headers the exact path sends to `rpcUrl` (`rpcHeaders`, `SOLANA_RPC_HEADERS`, `SOLANA_RPC_API_KEY`). */
  rpcHeaders?: Record<string, string>;
}

/** The RPC endpoint, and the headers it needs, for the batch scheme call in progress. */
interface RpcScope {
  url: string;
  headers: Record<string, string>;
}
/**
 * The scope store and the `fetch` hook marker are shared through
 * `globalThis` under `Symbol.for` keys, so that with two copies of this
 * module loaded (the CJS and ESM builds, or two installs of the package)
 * whichever copy installed the hook sees every copy's scope. A per-copy
 * store would let the second copy find the hook installed and skip it, and
 * its RPC requests would silently go out without `rpcHeaders`.
 */
const RPC_SCOPE_STORE = Symbol.for("@blockrun/llm/batch-rpc-scope/v1");
const RPC_HEADER_HOOK = Symbol.for("@blockrun/llm/batch-rpc-headers/v1");
const sharedGlobal = globalThis as typeof globalThis & { [RPC_SCOPE_STORE]?: AsyncLocalStorage<RpcScope> };
const rpcScope: AsyncLocalStorage<RpcScope> = (sharedGlobal[RPC_SCOPE_STORE] ??= new AsyncLocalStorage<RpcScope>());
type HookedFetch = typeof fetch & { [RPC_HEADER_HOOK]?: true };

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/**
 * Let the batch scheme's RPC calls carry `rpcHeaders`.
 *
 * `@x402/svm`'s batch client builds its RPC client from `rpcUrl` alone (its
 * config has no headers), and `@solana/kit`'s HTTP transport calls the global
 * `fetch`. So the headers go in through a thin wrapper around the global
 * `fetch`: inside a batch scheme call (an AsyncLocalStorage scope), a request
 * to exactly that scope's RPC URL gets its headers; every other request
 * passes through untouched. The wrapper is installed only once a batch
 * client with `rpcHeaders` makes a call, and re-installed if something
 * replaces the global `fetch` later.
 */
function installRpcHeaderHook(): void {
  const current = globalThis.fetch as HookedFetch;
  if (current[RPC_HEADER_HOOK]) return;
  const hooked: HookedFetch = (input, init) => {
    const scope = rpcScope.getStore();
    if (!scope || requestUrl(input) !== scope.url) return current(input, init);
    const headers = new Headers(scope.headers);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    return current(input, { ...init, headers });
  };
  hooked[RPC_HEADER_HOOK] = true;
  globalThis.fetch = hooked;
}

/**
 * Batch state shared by every client of one wallet in this process.
 *
 * Each SolanaLLMClient builds its own payer, and a client per request is a
 * common pattern. If each kept its own scheme, two of them could open two
 * channels for one wallet, or top up one channel from two stale balances and
 * lock more than `maxDeposit` between them. So the scheme, the in-flight flag
 * and the channel file belong to the wallet, not to the client, and they live
 * in the process-wide registry ({@link BATCH_REGISTRY}), so every copy of the
 * SDK loaded in the process uses the same ones.
 */
interface WalletBatch {
  config: string;
  client?: Promise<BuiltClient>;
  busy: boolean;
  /** Until when (ms since the epoch) the gateway asked this wallet to back off. */
  cooldownUntil: number;
  /** The scheme's channel store, kept across scheme rebuilds. */
  book: ChannelBook;
  /** Channel records to re-read from the chain before the next payment, by storage key. */
  resyncs: Map<string, ResyncTarget>;
  /** Deposits sent and not yet reconciled, written ahead of the send. */
  intents: IntentJournal;
}

/**
 * Queue a channel re-read, merged with one already queued for the channel:
 * the stricter expectations win, and an anchor height already taken is kept.
 */
function addResyncTarget(wallet: WalletBatch, target: ResyncTarget): void {
  const existing = wallet.resyncs.get(target.key);
  if (!existing) {
    wallet.resyncs.set(target.key, target);
    return;
  }
  wallet.resyncs.set(target.key, {
    ...existing,
    channelConfig: target.channelConfig,
    cumulative: maxOf(existing.cumulative, target.cumulative) ?? 0n,
    expectDeposit: maxOf(existing.expectDeposit, target.expectDeposit),
    knownDeposit: maxOf(existing.knownDeposit, target.knownDeposit),
    anchorHeight:
      existing.anchorHeight === undefined || target.anchorHeight === undefined
        ? (existing.anchorHeight ?? target.anchorHeight)
        : Math.max(existing.anchorHeight, target.anchorHeight),
  });
}

/** A journaled deposit intent as the chain re-read it needs. */
function intentTarget(intent: DepositIntent): ResyncTarget {
  return {
    key: intent.key,
    channelId: intent.channelId,
    channelConfig: intent.channelConfig,
    cumulative: parseAtomic(intent.cumulative),
    expectDeposit: parseAtomic(intent.expectDeposit),
    ...(intent.knownDeposit !== undefined ? { knownDeposit: parseAtomic(intent.knownDeposit) } : {}),
    ...(intent.anchorHeight !== undefined ? { anchorHeight: intent.anchorHeight } : {}),
    reason: "orphaned_deposit",
  };
}

/** Why a client cannot use its wallet's batch state at all. */
interface WalletRefusal {
  reason: "wallet_config_conflict" | "channel_store_locked" | "deposit_journal_unreadable";
  detail: string;
}

/**
 * One wallet's batch-settlement payer. Owned by a SolanaLLMClient.
 *
 * At most one batch request is in flight per wallet: the server-signed scheme
 * allows a single pending authorization per channel. Concurrent calls do not
 * queue behind it, they pay with `exact`, so batch never makes a parallel
 * workload slower than it is today. The exception is a 429 cooldown: then
 * every call for the wallet waits it out (within its own `rateLimit` budget)
 * rather than send the gateway another channel open it would refuse.
 */
export class SolanaBatchPayer {
  private state?: Promise<WalletBatch | WalletRefusal>;
  private readonly maxAttempts: number;
  private readonly maxWaitMs: number;
  private readonly counters: SolanaBatchStats = {
    fallbacks: 0,
    fallbacksByReason: {},
    backoffs: 0,
    retries: 0,
    recoveries: 0,
    resyncs: 0,
    unresolved: 0,
    unresolvedByReason: {},
  };

  constructor(private readonly init: SolanaBatchPayerInit) {
    const { operators, rateLimit } = init.options;
    if (!Array.isArray(operators) || operators.length === 0 || operators.some((o) => typeof o !== "string" || !o)) {
      throw new Error("batch.operators must list at least one base58 operator public key");
    }
    this.maxAttempts = rateLimit?.maxAttempts ?? DEFAULT_BATCH_RATE_LIMIT.maxAttempts;
    this.maxWaitMs = rateLimit?.maxWaitMs ?? DEFAULT_BATCH_RATE_LIMIT.maxWaitMs;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("batch.rateLimit.maxAttempts must be an integer >= 1");
    }
    if (!Number.isFinite(this.maxWaitMs) || this.maxWaitMs < 0) {
      throw new Error("batch.rateLimit.maxWaitMs must be a finite number of ms >= 0");
    }
  }

  /** A copy of this client's batch counters. */
  stats(): SolanaBatchStats {
    return {
      ...this.counters,
      fallbacksByReason: { ...this.counters.fallbacksByReason },
      unresolvedByReason: { ...this.counters.unresolvedByReason },
    };
  }

  private async storeFile(): Promise<string | undefined> {
    const { channelStore } = this.init.options;
    if (channelStore === false) return undefined;
    return path.resolve(channelStore ?? path.join(corePaths().dir, "solana-batch", `${await this.init.address()}.json`));
  }

  /**
   * This wallet's shared batch state, or why this client cannot use batch:
   * another client in this process holds the wallet with a different trust
   * configuration, or another live process owns its channel file.
   */
  private wallet(): Promise<WalletBatch | WalletRefusal> {
    this.state ??= (async (): Promise<WalletBatch | WalletRefusal> => {
      const address = await this.init.address();
      const file = await this.storeFile();
      const { operators, maxDeposit } = this.init.options;
      const headers = Object.entries(this.init.rpcHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b));
      const config = JSON.stringify([[...operators].sort(), String(maxDeposit ?? ""), file ?? null, this.init.rpcUrl, headers]);
      const existing = registry.wallets.get(address);
      if (existing) {
        return existing.config === config
          ? existing
          : {
              reason: "wallet_config_conflict",
              detail: "another client in this process uses this wallet with different batch options",
            };
      }
      if (file) {
        const owner = lockChannelFile(file);
        if (owner !== undefined) {
          return {
            reason: "channel_store_locked",
            detail:
              owner === process.pid
                ? `channel store ${file} is in use by another copy of @blockrun/llm in this process ` +
                  `(or by a process that had this pid and died: remove ${file}.lock if nothing uses it)`
                : `channel store ${file} is in use by process ${owner}`,
          };
        }
      }
      const resyncs = new Map<string, ResyncTarget>();
      const base: OwnedChannelStorage = file ? new FileChannelStorage(file) : new MemoryChannelStorage();
      const book = new ChannelBook(base, (target) => addResyncTarget(created, target));
      const intents: IntentJournal = file ? FileIntentJournal.beside(file) : new MemoryIntentJournal();
      let journaled: DepositIntent[];
      try {
        // Intents an earlier build journaled under the old, shared path.
        if (file) (intents as FileIntentJournal).adoptLegacy(FileIntentJournal.legacyBeside(file), address);
        journaled = intents.list();
      } catch (err) {
        // Unknown whether a deposit is in doubt: batch stays off for this wallet.
        return {
          reason: "deposit_journal_unreadable",
          detail: `cannot read ${(intents as FileIntentJournal).file}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const created: WalletBatch = { config, busy: false, cooldownUntil: 0, book, resyncs, intents };
      // A deposit journaled by a process that died is in doubt: settle it
      // from the chain before anything pays into the wallet's channels.
      for (const intent of journaled) addResyncTarget(created, intentTarget(intent));
      registry.wallets.set(address, created);
      return created;
    })();
    return this.state;
  }

  private build(wallet: WalletBatch): Promise<BuiltClient> {
    wallet.client ??= (async () => {
      const [core, svm, kit] = await Promise.all([
        load("@x402/core", () => import("@x402/core/client")),
        load("@x402/svm", () => import("@x402/svm/batch-settlement/client")),
        load("@solana/kit", () => import("@solana/kit")),
      ]);
      const signer = await kit.createKeyPairSignerFromBytes(await this.init.secretKey());
      const scheme = new svm.BatchSvmScheme(signer, {
        rpcUrl: this.init.rpcUrl,
        serverSignedChannelsPolicy: {
          allowedOperators: this.init.options.operators,
          maxDeposit: this.init.options.maxDeposit ?? svm.DEFAULT_SERVER_SIGNED_MAX_DEPOSIT,
        },
        // Always a store, memory included: a record the SDK repairs from the
        // chain survives the scheme being rebuilt to pick it up.
        channelStorage: wallet.book as never,
      });
      // Only the batch scheme is registered: exact stays on this SDK's own
      // signer, so a 402 without a usable batch accept throws here and the
      // caller pays it exactly as before. The per-call ceiling is bounded by
      // the gateway; the escrow is bounded by maxDeposit, not by core's $1
      // per-payment default.
      const client = new core.x402Client()
        .register("solana:*", scheme)
        .registerPolicy(scheme.paymentPolicy);
      client.setSpendControls({ maxAmountPerPayment: false });
      // Every call that can reach the RPC runs with this client's RPC headers.
      const raw = new core.x402HTTPClient(client) as unknown as HttpPaymentClient;
      const http: HttpPaymentClient = {
        getPaymentSettleResponse: (getHeader) => raw.getPaymentSettleResponse(getHeader),
        createPaymentPayload: (paymentRequired) => this.withRpcHeaders(() => raw.createPaymentPayload(paymentRequired)),
        encodePaymentSignatureHeader: (payload) => raw.encodePaymentSignatureHeader(payload),
        processPaymentResult: (payload, getHeader, status) =>
          this.withRpcHeaders(() => raw.processPaymentResult(payload, getHeader, status)),
      };
      return {
        http,
        refund: (url: string) => this.withRpcHeaders(() => scheme.refund(url)),
      };
    })();
    wallet.client.catch(() => { wallet.client = undefined; });
    return wallet.client;
  }

  /** Run a scheme call so its RPC requests carry this client's `rpcHeaders`. */
  private withRpcHeaders<T>(call: () => Promise<T>): Promise<T> {
    const headers = this.init.rpcHeaders;
    if (!headers || Object.keys(headers).length === 0) return call();
    installRpcHeaderHook();
    return rpcScope.run({ url: this.init.rpcUrl, headers }, call);
  }

  /**
   * Drop everything this wallet knows about its channel, on disk and in
   * memory. The next call rebuilds the scheme, which reads the channel's real
   * state (deposit, open or closed) from the chain.
   */
  private forget(wallet: WalletBatch): void {
    wallet.client = undefined;
    wallet.resyncs.clear();
    wallet.book.clear();
  }

  /**
   * Stop trusting the record of the channel a payload paid into: the next
   * payment re-reads that channel from the chain first. The scheme has
   * already restored (or, for an open, dropped) its record; the book still
   * knows the channel and the cumulative it last confirmed.
   */
  private distrust(
    wallet: WalletBatch,
    sent: SentPayment,
    reason: ResyncTarget["reason"],
    charged = 0n,
  ): void {
    const { payload } = sent;
    const channelId = payloadChannelId(payload);
    const known = channelId ? wallet.book.find(channelId) : undefined;
    if (!channelId || !known) {
      // Nothing to re-read by id (the scheme always stores a record before a
      // payment, so this should not happen). Drop the scheme's memory so it
      // reloads what storage holds; never delete the stored record.
      wallet.client = undefined;
      return;
    }
    const { key, record } = known;
    const hasConfirmed = record.pending === undefined || record.hasConfirmedState;
    const confirmed = hasConfirmed ? parseAtomic(record.chargedCumulativeAmount) : 0n;
    // The pre-send expectation: a non-2xx answer can carry a success receipt
    // the scheme has already committed, so the record may include the
    // deposit by now, and adding it again would double-count it.
    const expectDeposit = sent.expectDeposit ?? this.depositExpectation(wallet, payload).expectDeposit;
    addResyncTarget(wallet, {
      key,
      channelId,
      channelConfig: record.channelConfig,
      cumulative: confirmed + charged,
      ...(hasConfirmed ? { knownDeposit: parseAtomic(record.deposit) } : {}),
      ...(expectDeposit !== undefined ? { expectDeposit } : {}),
      reason,
    });
  }

  /**
   * The channel's total deposit if a deposit payload landed: the confirmed
   * deposit plus this one (for an open, nothing plus this one). Undefined for
   * a payment without a deposit, or a channel the SDK has no record of.
   */
  private depositExpectation(wallet: WalletBatch, payload: PaymentPayloadLike): { expectDeposit?: bigint } {
    if (payload.payload?.type !== "deposit") return {};
    const channelId = payloadChannelId(payload);
    const record = channelId ? wallet.book.find(channelId)?.record : undefined;
    if (!record) return {};
    const hasConfirmed = record.pending === undefined || record.hasConfirmedState;
    return { expectDeposit: (hasConfirmed ? parseAtomic(record.deposit) : 0n) + parseAtomic(payload.payload.deposit?.amount) };
  }

  /**
   * Re-read every distrusted channel from the chain, at `finalized`
   * commitment, and rewrite its record: the on-chain deposit, and the highest
   * of the cumulative the SDK can vouch for, the cumulative the stored record
   * already confirmed, and the on-chain settled amount. A closing or closed
   * channel is dropped. The scheme is rebuilt to load the repaired record.
   *
   * The stored cumulative is never moved backwards. A deposit's intent can
   * outlive the receipt that reconciled it (the process died, or the journal
   * could not be cleared, after the scheme saved the new state), so its
   * cumulative may predate vouchers the scheme has since confirmed; and
   * vouchers are redeemed on-chain asynchronously, so `settled` can lag too.
   * Rewriting the record with either would leave every later voucher
   * unreconcilable.
   *
   * A deposit in doubt is settled by the chain alone:
   * - landed: the finalized channel holds at least the deposit it would
   *   bring (and at least what the record already claimed);
   * - never landed: the finalized chain is {@link LANDING_MARGIN_BLOCKS}
   *   past the target's anchor height, and a read at least that recent still
   *   does not show it. An open's record is then dropped; a top-up's channel
   *   is rewritten with the deposit it really has.
   * Until one of those holds, it is pending. This settles only the deposit:
   * whether the gateway charged the payment that carried it is never read
   * from the chain.
   *
   * @throws ResyncError when the chain cannot be read, or a deposit may still
   *   land: the caller pays exact and the re-read is tried again next call.
   *   Nothing opens or tops up a channel while any re-read is pending.
   */
  private async resync(wallet: WalletBatch): Promise<void> {
    for (const target of [...wallet.resyncs.values()]) {
      const failed = (err: unknown): ResyncError =>
        err instanceof ResyncError
          ? err
          : err instanceof ChannelUnreadableError
            ? new ResyncError("channel_unreadable", err.message)
            : err instanceof ChannelLayoutError
              ? new ResyncError("channel_unreadable", `channel ${target.channelId}: ${err.message}`)
              : new ResyncError(
                  "channel_resync_failed",
                  `could not read channel ${target.channelId} from the chain: ${err instanceof Error ? err.message : String(err)}`,
                );
      let channel: OnChainChannel | undefined;
      let expired = false;
      let stored: StoredRecord | undefined;
      try {
        channel = await this.readOwnChannel(target);
        const required = maxOf(target.expectDeposit, target.knownDeposit) ?? 0n;
        if (channel === undefined || (channel.open && channel.deposit < required)) {
          // Short of what it should hold: proof it never will needs finality
          // past the deposit's last valid block, then a read at least that recent.
          if (target.anchorHeight === undefined) {
            // Any block height read after the payment was built is at least
            // the height of the blockhash it was built with.
            target.anchorHeight = rpcInteger(
              await rpcRequest(this.init.rpcUrl, "getBlockHeight", [{ commitment: "confirmed" }], this.init.rpcHeaders),
              "getBlockHeight",
            );
            try {
              const intent = wallet.intents.list().find((candidate) => candidate.key === target.key);
              if (intent) wallet.intents.put({ ...intent, anchorHeight: target.anchorHeight });
            } catch {
              // Only saves re-anchoring after a restart.
            }
          }
          const epoch = (await rpcRequest(this.init.rpcUrl, "getEpochInfo", [{ commitment: "finalized" }], this.init.rpcHeaders)) as {
            absoluteSlot?: unknown;
            blockHeight?: unknown;
          };
          const finalizedHeight = rpcInteger(epoch.blockHeight, "getEpochInfo blockHeight");
          const finalizedSlot = rpcInteger(epoch.absoluteSlot, "getEpochInfo absoluteSlot");
          if (finalizedHeight <= target.anchorHeight + LANDING_MARGIN_BLOCKS) {
            throw new ResyncError(
              "channel_resync_pending",
              channel === undefined
                ? `channel ${target.channelId} is not finalized on chain, and its deposit may still land`
                : `channel ${target.channelId} holds ${channel.deposit} finalized, short of the ${required} it should hold, and a deposit may still land`,
            );
          }
          channel = await this.readOwnChannel(target, finalizedSlot);
          expired = true;
        }
        // What the scheme last saved for the channel, read raw: the book
        // would refuse a record with a pending deposit.
        stored = await wallet.book.base.get(target.key);
      } catch (err) {
        // Fail closed: keep the record and pay exact. An account that exists
        // but cannot be read is never taken for "no channel".
        throw failed(err);
      }
      let outcome: string;
      if (channel === undefined) {
        await wallet.book.delete(target.key);
        outcome = "no such channel at finalized commitment, past its deposit's last valid block; record dropped";
      } else if (!channel.open) {
        await wallet.book.delete(target.key);
        outcome = "channel is closing or closed; record dropped";
      } else {
        const cumulative = maxOf(maxOf(target.cumulative, channel.settled), confirmedCumulative(stored, target.channelId)) ?? 0n;
        await wallet.book.set(target.key, {
          channelConfig: target.channelConfig,
          channelId: target.channelId,
          chargedCumulativeAmount: cumulative.toString(),
          deposit: channel.deposit.toString(),
        });
        outcome =
          `record rewritten from finalized chain: deposit=${channel.deposit} settled=${channel.settled} cumulative=${cumulative}` +
          (expired ? " (the deposit in doubt never landed)" : "");
      }
      wallet.resyncs.delete(target.key);
      this.forgetIntent(wallet, target.key);
      wallet.client = undefined;
      await this.report({ type: "resync", reason: target.reason, detail: `channel ${target.channelId}: ${outcome}` });
    }
  }

  /**
   * A distrusted channel's account at `finalized` commitment, checked to be
   * this wallet's channel for the record's operator and mint.
   *
   * @throws ResyncError (`channel_unreadable`) for any other payment channel.
   */
  private async readOwnChannel(target: ResyncTarget, minContextSlot?: number): Promise<OnChainChannel | undefined> {
    const channel = await readChannelAccount(this.init.rpcUrl, target.channelId, this.init.rpcHeaders, { minContextSlot });
    if (
      channel !== undefined &&
      (channel.payer !== (await this.init.address()) ||
        channel.authorizedSigner !== target.channelConfig.payerAuthorizer ||
        channel.mint !== target.channelConfig.token)
    ) {
      throw new ResyncError("channel_unreadable", `account ${target.channelId} is a payment channel for another payer, operator or mint`);
    }
    return channel;
  }

  /**
   * Make one event observable three ways: a stderr line (every time, never
   * deduplicated), this client's counters, and the caller's `onEvent`.
   */
  private async report(event: Omit<SolanaBatchEvent, "wallet" | "at">): Promise<void> {
    let wallet: string;
    try {
      wallet = await this.init.address();
    } catch {
      wallet = "unknown";
    }
    const full: SolanaBatchEvent = { ...event, wallet, at: Date.now() };
    if (full.type === "fallback") {
      this.counters.fallbacks += 1;
      this.counters.fallbacksByReason[full.reason] = (this.counters.fallbacksByReason[full.reason] ?? 0) + 1;
    } else if (full.type === "backoff") {
      this.counters.backoffs += 1;
    } else if (full.type === "recovered") {
      this.counters.recoveries += 1;
    } else if (full.type === "unresolved") {
      this.counters.unresolved += 1;
      this.counters.unresolvedByReason[full.reason] = (this.counters.unresolvedByReason[full.reason] ?? 0) + 1;
    } else {
      this.counters.resyncs += 1;
    }
    console.error(formatEvent(full));
    const failed = (err: unknown) =>
      console.error(
        `[@blockrun/llm] batch-settlement onEvent callback threw: ${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
    try {
      const result: unknown = this.init.options.onEvent?.(full);
      // An async callback's rejection is handled here, never left unhandled.
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, failed);
      }
    } catch (err) {
      failed(err);
    }
  }

  /** Report a fallback and tell the caller to pay exact. */
  private async fallback(event: Omit<SolanaBatchEvent, "wallet" | "at" | "type">): Promise<{ kind: "fallback"; reason: string }> {
    await this.report({ type: "fallback", ...event });
    return { kind: "fallback", reason: event.reason };
  }

  /**
   * Pay one 402 with batch-settlement, or say why the caller should use exact.
   *
   * `send` replays the original request with the payment headers. Every send
   * goes through {@link sendOnce}, the one place an answer is classified as
   * charged, not charged, or in doubt:
   *
   * - charged: the 2xx is returned (`paid`);
   * - not charged (the gateway's explicit answer to a first send): a 429
   *   whose receipt proves nothing was broadcast is backed off
   *   (`Retry-After`, else 1s, 2s, 4s with jitter) and paid again with a new
   *   payment built from a fresh 402 (`rechallenge`: the original's
   *   `recentBlockhash` / `recentSlot` can be stale by then), within
   *   `rateLimit.maxAttempts` / `maxWaitMs`, then with exact; any other is
   *   paid with exact (`fallback`). A fresh challenge served with a 2xx is
   *   the call's result (`served`, nothing paid); one that fails otherwise
   *   is the call's error (`failed`, `"unpaid"`), never an exact payment
   *   against the stale challenge;
   * - in doubt: ends only with a definitive success receipt from the one
   *   replay a receipt-less 429 is allowed ({@link resolveInDoubt}), or a
   *   thrown {@link BatchPaymentUnresolvedError}. No new authorization, no
   *   new deposit, no exact payment and no fallback model is ever paid for a
   *   call in doubt.
   *
   * The wallet stays in cooldown after a 429, so its other calls wait
   * instead of sending opens of their own.
   */
  async pay(
    paymentRequired: PaymentRequired,
    send: (headers: Record<string, string>) => Promise<Response>,
    rechallenge: () => Promise<Rechallenge>,
  ): Promise<BatchAttempt> {
    const unavailable = batchUnavailable(paymentRequired);
    if (unavailable) return this.fallback(unavailable);
    let wallet: WalletBatch | WalletRefusal;
    try {
      wallet = await this.wallet();
    } catch (err) {
      // Nothing was sent (say, the channel store's directory is not writable).
      return this.fallback(creationFailure(err));
    }
    if ("reason" in wallet) return this.fallback({ reason: wallet.reason, detail: wallet.detail });
    return this.payWith(wallet, paymentRequired, send, rechallenge);
  }

  /** {@link pay}, for a wallet this client may use. */
  private async payWith(
    wallet: WalletBatch,
    paymentRequired: PaymentRequired,
    send: (headers: Record<string, string>) => Promise<Response>,
    rechallenge: () => Promise<Rechallenge>,
  ): Promise<BatchAttempt> {
    let current = paymentRequired;
    // A fallback pays exact against the freshest 402 this call holds.
    const fallback = async (event: Omit<SolanaBatchEvent, "wallet" | "at" | "type">): Promise<BatchAttempt> => {
      const result = await this.fallback(event);
      return current === paymentRequired ? result : { ...result, paymentRequired: current };
    };
    const budget = { attempt: 1, waited: 0 };
    let waitedUntil = 0;
    let backedOff: "rate_limited" | "cooldown" | undefined;
    let holding = false;
    // This call's payment once it is sent and until it is proven not
    // charged. While set, nothing else is paid for the call.
    let sent: SentPayment | undefined;
    const release = () => {
      if (holding) wallet.busy = false;
      holding = false;
    };
    try {
      for (;;) {
        // A cooldown this call has not already waited out: another call's
        // 429. Wait for it if the budget allows, else pay exact.
        const now = Date.now();
        if (wallet.cooldownUntil > now && wallet.cooldownUntil !== waitedUntil) {
          const wait = wallet.cooldownUntil - now;
          if (budget.waited + wait > this.maxWaitMs) {
            return fallback({
              reason: "rate_limited",
              retryAfterMs: wait,
              attempt: budget.attempt,
              detail: "wallet is in a 429 cooldown longer than batch.rateLimit.maxWaitMs allows",
            });
          }
          await this.report({ type: "backoff", reason: "cooldown", retryAfterMs: wait, attempt: budget.attempt });
          backedOff ??= "cooldown";
          waitedUntil = wallet.cooldownUntil;
          budget.waited += wait;
          await sleep(wait);
          continue;
        }

        // Every new payment after a wait starts from a fresh challenge. The
        // challenge request is the call itself, unpaid: nothing has been paid
        // for the call so far (the 429 it waited out proved it), and once it
        // is sent the challenge this call held is stale, so no exact payment
        // is ever signed against it.
        if (budget.attempt > 1 || budget.waited > 0) {
          let fresh: Rechallenge;
          try {
            fresh = await rechallenge();
          } catch (err) {
            return { kind: "failed", error: withDisposition(err instanceof Error ? err : new Error(String(err)), "unpaid") };
          }
          if (fresh.kind === "served") {
            await this.report({
              type: "recovered",
              reason: "served_unpaid_on_rechallenge",
              status: fresh.response.status,
              attempt: budget.attempt,
              detail: "the fresh challenge after the wait was served without a payment; nothing was paid",
            });
            return { kind: "served", response: fresh.response };
          }
          current = fresh.paymentRequired;
          const unavailable = batchUnavailable(current);
          if (unavailable) return fallback({ ...unavailable, attempt: budget.attempt });
        }
        if (wallet.busy) return fallback({ reason: "channel_busy", attempt: budget.attempt });
        wallet.busy = true;
        holding = true;

        let built: SentPayment;
        try {
          built = await this.buildPayment(wallet, current);
        } catch (err) {
          release();
          if (err instanceof ResyncError) return fallback({ reason: err.reason, detail: err.message, attempt: budget.attempt });
          return fallback({ ...creationFailure(err), attempt: budget.attempt });
        }
        if (built.kind !== "authorization") {
          try {
            this.journalDeposit(wallet, built);
          } catch (err) {
            // Not recorded, so not sent: release it and pay exact.
            await this.settle(built.http, built.payload, () => null, 0);
            release();
            return fallback({
              reason: "deposit_journal_failed",
              attempt: budget.attempt,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
        sent = built;
        // A pass after this call's own 429 is a retry, counted when it is sent.
        const outcome = await this.sendOnce(wallet, built, send, backedOff === "rate_limited", false);

        if (outcome.kind === "charged") {
          // Reconciled by its receipt, unless the channel is now queued for a re-read.
          if (built.kind !== "authorization" && !(built.key && wallet.resyncs.has(built.key))) this.forgetIntent(wallet, built.key);
          sent = undefined;
          release();
          if (backedOff) await this.report({ type: "recovered", reason: backedOff, attempt: budget.attempt });
          return { kind: "paid", response: outcome.response, chargedUsd: outcome.chargedUsd };
        }

        if (outcome.kind === "not_charged") {
          // Proven not charged, nothing broadcast: this call may pay again.
          if (built.kind !== "authorization") this.forgetIntent(wallet, built.key);
          sent = undefined;
          release();
          if (!outcome.rateLimited) {
            const { kind: _kind, rateLimited: _limited, ...event } = outcome;
            return fallback({ ...event, attempt: budget.attempt });
          }
          const wait = this.coolDown(wallet, outcome.rateLimited.retryAfterMs ?? backoffDelay(budget.attempt));
          if (budget.attempt >= this.maxAttempts || budget.waited + wait > this.maxWaitMs) {
            return fallback({
              reason: "rate_limited",
              status: 429,
              errorReason: outcome.errorReason,
              retryAfterMs: wait,
              attempt: budget.attempt,
              detail: budget.attempt >= this.maxAttempts
                ? "batch.rateLimit.maxAttempts reached"
                : "Retry-After exceeds what is left of batch.rateLimit.maxWaitMs",
            });
          }
          await this.report({
            type: "backoff",
            reason: "rate_limited",
            status: 429,
            errorReason: outcome.errorReason,
            retryAfterMs: wait,
            attempt: budget.attempt,
          });
          backedOff = "rate_limited";
          waitedUntil = wallet.cooldownUntil;
          budget.waited += wait;
          await sleep(wait);
          budget.attempt += 1;
          continue;
        }

        // In doubt. The wallet stays busy until it is resolved or raised.
        const resolved = await this.resolveInDoubt(wallet, built, outcome, send, budget);
        if (resolved.kind === "charged") {
          if (built.kind !== "authorization" && !(built.key && wallet.resyncs.has(built.key))) this.forgetIntent(wallet, built.key);
          sent = undefined;
          release();
          await this.report({ type: "recovered", reason: "rate_limited", attempt: budget.attempt });
          return { kind: "paid", response: resolved.response, chargedUsd: resolved.chargedUsd };
        }
        return await this.raiseUnresolved(wallet, built, resolved, budget.attempt);
      }
    } catch (err) {
      // Nothing escapes as a raw error once a payment was sent: whatever
      // went wrong, it may have been charged.
      if (err instanceof Error && err.name === "BatchPaymentUnresolvedError") throw err;
      if (sent) {
        try {
          return await this.raiseUnresolved(
            wallet,
            sent,
            {
              kind: "in_doubt",
              reason: "outcome_unknown",
              replayable: false,
              settled: false,
              detail: `an error after the payment was sent: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            },
            budget.attempt,
          );
        } catch (raised) {
          // Even if raising itself failed, never let it read as retryable.
          throw withDisposition(raised, "paid-or-in-doubt");
        }
      }
      // Nothing was sent for this call: exact is still its only payment.
      return fallback({ ...creationFailure(err), attempt: budget.attempt });
    } finally {
      release();
    }
  }

  /**
   * Put the wallet in a 429 cooldown for `delay` ms (`Retry-After`, or the
   * default backoff), and return how long this call would have to wait.
   *
   * The shared cooldown is capped at `rateLimit.maxWaitMs`, so one header,
   * however long, never keeps the wallet's calls off batch for longer than
   * the retry budget. This call still weighs the full delay: one it cannot
   * wait out within its budget is not waited at all, and the caller pays
   * exact (or raises a payment in doubt) at once.
   */
  private coolDown(wallet: WalletBatch, delay: number): number {
    const limitedAt = Date.now();
    wallet.cooldownUntil = Math.max(wallet.cooldownUntil, limitedAt + Math.min(delay, this.maxWaitMs));
    return Math.max(delay, wallet.cooldownUntil - limitedAt);
  }

  /**
   * Try to end a payment in doubt with the gateway's own word.
   *
   * The one source of evidence this SDK accepts today is a definitive
   * success receipt on the single byte-identical replay a 429 without a
   * receipt is allowed, after its backoff (the owner's bounded safety
   * attempt). Any other answer to it (a 402 or `duplicate_settlement`, which
   * mean the original reached the gateway; another 429; a 5xx; a timeout)
   * leaves it in doubt. Every other in-doubt outcome is never replayed.
   *
   * Chain state is not evidence here: it can settle a deposit (see
   * `resync`), never whether the gateway charged. Gateway-side evidence (a
   * receipt on every response, a request-status endpoint with a fence)
   * plugs in here, before the caller raises.
   *
   * @returns the charged replay, or the doubt to raise.
   */
  private async resolveInDoubt(
    wallet: WalletBatch,
    sent: SentPayment,
    doubt: InDoubt,
    send: (headers: Record<string, string>) => Promise<Response>,
    budget: { attempt: number; waited: number },
  ): Promise<Extract<SendOutcome, { kind: "charged" }> | InDoubt> {
    if (!doubt.replayable) return doubt;
    const wait = this.coolDown(wallet, doubt.retryAfterMs ?? backoffDelay(budget.attempt));
    if (budget.attempt >= this.maxAttempts || budget.waited + wait > this.maxWaitMs) {
      return {
        ...doubt,
        detail: `${doubt.detail}; batch.rateLimit leaves no room for its one replay`,
      };
    }
    await this.report({
      type: "backoff",
      reason: "rate_limited",
      status: 429,
      errorReason: doubt.errorReason,
      retryAfterMs: wait,
      attempt: budget.attempt,
    });
    budget.waited += wait;
    await sleep(wait);
    budget.attempt += 1;
    const replayed = await this.sendOnce(wallet, sent, send, true, true);
    if (replayed.kind === "charged") return replayed;
    // A replay is never proof of "not charged" (sendOnce does not mint one).
    return replayed.kind === "in_doubt"
      ? replayed
      : { kind: "in_doubt", reason: "replay_unresolved", replayable: false, settled: true, detail: "the replay was refused" };
  }

  /**
   * Raise a payment in doubt: release the scheme's hold on it (the channel
   * goes back to its confirmed state), put a deposit's channel in doubt so
   * it is re-read from the chain before anything pays into it again, report
   * the `unresolved` event, and throw {@link BatchPaymentUnresolvedError}.
   */
  private async raiseUnresolved(wallet: WalletBatch, sent: SentPayment, doubt: InDoubt, attempt: number): Promise<never> {
    if (!doubt.settled) await this.settle(sent.http, sent.payload, () => null, 0);
    if (sent.kind !== "authorization") {
      this.distrust(
        wallet,
        sent,
        doubt.reason === "no_response"
          ? "deposit_unanswered"
          : doubt.reason === "replay_unresolved"
            ? "deposit_rate_limited"
            : "deposit_failed",
      );
    }
    await this.report({
      type: "unresolved",
      reason: doubt.reason,
      status: doubt.status,
      errorReason: doubt.errorReason,
      attempt,
      detail: `${doubt.detail}; it may have been charged, so it is not paid again`,
    });
    throw new BatchPaymentUnresolvedError({
      reason: doubt.reason,
      wallet: await this.init.address(),
      requestId: sent.payload.payload?.authorization?.requestId,
      channelId: payloadChannelId(sent.payload),
      payloadKind: sent.kind,
      status: doubt.status,
      detail: doubt.detail,
      cause: doubt.cause,
    });
  }

  /** Build a new batch payment for a 402: the payload, its headers and its kind. */
  private async buildPayment(wallet: WalletBatch, paymentRequired: PaymentRequired): Promise<SentPayment> {
    const { http, payload } = await this.createPayload(wallet, paymentRequired);
    const headers = http.encodePaymentSignatureHeader(payload);
    const channelId = payloadChannelId(payload);
    const known = channelId ? wallet.book.find(channelId) : undefined;
    let kind: BatchPayloadKind = "authorization";
    if (payload.payload?.type === "deposit") {
      const record = known?.record;
      kind = record && (record.pending === undefined || record.hasConfirmedState) ? "top-up" : "open";
    }
    return { http, payload, headers, kind, key: known?.key, sentAt: Date.now(), sends: 0 };
  }

  /**
   * Write a deposit's intent to the wallet's journal before it is sent
   * (with the file store: the file and its directory fsynced).
   *
   * @throws when it cannot be recorded; the deposit must then not be sent.
   */
  private journalDeposit(wallet: WalletBatch, sent: SentPayment): void {
    const channelId = payloadChannelId(sent.payload);
    const record = channelId ? wallet.book.find(channelId)?.record : undefined;
    const { expectDeposit } = this.depositExpectation(wallet, sent.payload);
    if (!sent.key || !channelId || !record || expectDeposit === undefined || sent.kind === "authorization") {
      throw new Error("the deposit's channel record is missing");
    }
    const hasConfirmed = record.pending === undefined || record.hasConfirmedState;
    sent.expectDeposit = expectDeposit;
    wallet.intents.put({
      key: sent.key,
      channelId,
      channelConfig: record.channelConfig,
      requestId: sent.payload.payload?.authorization?.requestId,
      kind: sent.kind,
      cumulative: hasConfirmed ? String(parseAtomic(record.chargedCumulativeAmount)) : "0",
      expectDeposit: expectDeposit.toString(),
      ...(hasConfirmed ? { knownDeposit: String(parseAtomic(record.deposit)) } : {}),
      at: Date.now(),
    });
  }

  /**
   * Remove a deposit's intent once it is reconciled. A failure is logged,
   * not thrown: the intent then outlives its deposit, and after a restart
   * the chain re-read settles it again.
   */
  private forgetIntent(wallet: WalletBatch, key: string | undefined): void {
    if (!key) return;
    try {
      wallet.intents.remove(key);
    } catch (err) {
      console.error(
        `[@blockrun/llm] batch-settlement could not clear a deposit intent: ${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  /**
   * THE choke point: send a batch payment once and classify the answer.
   *
   * The only caller of `send` for a batch payment, and the only place its
   * outcome is decided (see {@link SendOutcome}). Every exception once the
   * send has started is `in_doubt`, whatever its type or `cause.code`: the
   * request may have reached the gateway. "Not charged" is only ever minted
   * here, and only for a first send.
   *
   * @param retry - count this send in `retries` (it follows this call's own 429).
   * @param replay - this is the one replay of a receipt-less 429: only a 2xx
   *   with a success receipt counts, everything else stays in doubt.
   */
  private async sendOnce(
    wallet: WalletBatch,
    sent: SentPayment,
    send: (headers: Record<string, string>) => Promise<Response>,
    retry: boolean,
    replay: boolean,
  ): Promise<SendOutcome> {
    if (retry) this.counters.retries += 1;
    sent.sends += 1;
    let response: Response;
    try {
      response = await send(sent.headers);
    } catch (err) {
      return {
        kind: "in_doubt",
        reason: replay ? "replay_unresolved" : "no_response",
        replayable: false,
        settled: false,
        detail: `${replay ? "the replay" : "the payment"} got no answer (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`,
        cause: err,
      };
    }
    try {
      return await this.classify(wallet, sent, response, replay);
    } catch (err) {
      return {
        kind: "in_doubt",
        reason: replay ? "replay_unresolved" : "outcome_unknown",
        replayable: false,
        settled: false,
        status: response.status,
        detail: `the answer could not be classified (${err instanceof Error ? err.message : String(err)})`,
        cause: err,
      };
    }
  }

  /** {@link sendOnce}'s classifier, for an HTTP answer. */
  private async classify(wallet: WalletBatch, sent: SentPayment, response: Response, replay: boolean): Promise<SendOutcome> {
    const { http, payload } = sent;
    const getHeader = (name: string) => response.headers.get(name);
    const receipted = Boolean(getHeader("PAYMENT-RESPONSE") || getHeader("X-PAYMENT-RESPONSE"));
    const status = response.status;

    if (status === 429 && !receipted) {
      // No receipt: it may or may not have gone through (a receipt can be
      // lost on the way back). Not handed to the scheme, which keeps it
      // pending: a first send gets one byte-identical replay.
      return {
        kind: "in_doubt",
        reason: "replay_unresolved",
        replayable: !replay,
        settled: false,
        status,
        retryAfterMs: parseRetryAfter(getHeader("retry-after")),
        errorReason: await rateLimitReason(response, undefined),
        detail: replay ? "the replay was answered 429 without a receipt" : "a 429 without a receipt",
      };
    }

    // Hand the answer to the scheme: it verifies the operator's voucher and
    // advances the channel, or rolls it back to its confirmed state.
    const reconciled = await this.settle(http, payload, getHeader, status);
    const receipt = reconciled.settleResponse;
    const definitive = receipt?.success === true && reconciled.ok;

    if (response.ok && (!replay || receipt?.success === true)) {
      if (!definitive) {
        // Served, but without a receipt the scheme could reconcile (none at
        // all, a rebuilt one without a voucher, or settlement_pending). Its
        // record may be behind the channel: re-read it from the chain
        // rather than open a new one or lose it.
        this.distrust(wallet, sent, receipt ? "receipt_unreconciled" : "receipt_missing", rebuiltCharge(receipt, payload));
      }
      return { kind: "charged", response, chargedUsd: chargedUsd(() => http.getPaymentSettleResponse(getHeader)) };
    }

    if (replay) {
      // A replay's answer only describes the replay. A 402 or
      // duplicate_settlement means the original reached the gateway.
      return {
        kind: "in_doubt",
        reason: "replay_unresolved",
        replayable: false,
        settled: true,
        status,
        errorReason: status === 429 ? await rateLimitReason(response, receipt) : receipt?.errorReason,
        detail: `the replay was answered ${status} with ${describeReceipt(receipt)}`,
        cause: await afterPaymentError(response),
      };
    }

    if (status === 429) {
      if (provesNothingBroadcast(receipt)) {
        return {
          kind: "not_charged",
          reason: "rate_limited",
          status,
          errorReason: await rateLimitReason(response, receipt),
          rateLimited: { retryAfterMs: parseRetryAfter(getHeader("retry-after")) },
        };
      }
      return {
        kind: "in_doubt",
        reason: "ambiguous_rate_limit",
        replayable: false,
        settled: true,
        status,
        errorReason: await rateLimitReason(response, receipt),
        detail: `a 429 whose ${describeReceipt(receipt)} does not prove nothing was broadcast`,
        cause: await afterPaymentError(response),
      };
    }

    if (cleanRefusalReceipt(receipt)) {
      if (status === 402) return { kind: "not_charged", reason: "payment_required", status };
      const refusal = await batchRefusal(response);
      // A refusal charges nothing, so a refused top-up leaves a healthy
      // channel exactly as it was confirmed. Keep it.
      if (refusal) return { kind: "not_charged", reason: refusal, status, errorReason: refusal };
    }

    return {
      kind: "in_doubt",
      reason: "outcome_unknown",
      replayable: false,
      settled: true,
      status,
      errorReason: receipt?.errorReason,
      detail: `the payment was answered ${status} with ${describeReceipt(receipt)}`,
      cause: await afterPaymentError(response),
    };
  }

  /**
   * Build the payment payload, re-reading any distrusted channel from the
   * chain first. A stored record the book refuses to hand over (a deposit a
   * dead process never heard back about) is re-read and the payload rebuilt
   * once.
   */
  private async createPayload(
    wallet: WalletBatch,
    paymentRequired: PaymentRequired,
  ): Promise<{ http: HttpPaymentClient; payload: PaymentPayloadLike }> {
    for (let pass = 0; ; pass += 1) {
      await this.resync(wallet);
      const http = (await this.build(wallet)).http;
      try {
        return { http, payload: await http.createPaymentPayload(paymentRequired) };
      } catch (err) {
        if (pass > 0 || !isResyncRequired(err) || wallet.resyncs.size === 0) throw err;
      }
    }
  }

  /**
   * Hand the gateway's answer to the scheme, which verifies the operator's
   * voucher and advances (or rolls back) the channel's local state.
   *
   * A malformed receipt must not lose a response the caller has been served,
   * so a scheme error is logged rather than thrown.
   */
  private async settle(
    http: HttpPaymentClient,
    payload: PaymentPayloadLike,
    getHeader: (name: string) => string | null | undefined,
    status: number,
  ): Promise<{ settleResponse?: SettleResponseLike; ok: boolean }> {
    try {
      return { settleResponse: (await http.processPaymentResult(payload, getHeader, status)).settleResponse, ok: true };
    } catch (err) {
      console.error(
        `[@blockrun/llm] batch-settlement receipt not reconciled: ${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
      let settleResponse: SettleResponseLike | undefined;
      try {
        settleResponse = http.getPaymentSettleResponse(getHeader);
      } catch {
        settleResponse = undefined;
      }
      return { settleResponse, ok: false };
    }
  }

  /**
   * Close the channel and return its unused escrow to the wallet.
   *
   * The scheme keeps a closed channel in its records, and would go on paying
   * into it, so a successful close forgets the channel. The next batch call
   * finds no open channel on-chain and opens a new one.
   *
   * @param url - any batch-enabled route on the gateway the channel was opened with.
   */
  async close(url: string): Promise<unknown> {
    const wallet = await this.wallet();
    if ("reason" in wallet) throw new Error(`batch-settlement unavailable: ${wallet.detail}`);
    if (wallet.busy) throw new Error("batch-settlement channel has a request in flight; close it when the call returns");
    wallet.busy = true;
    try {
      const result = await (await this.build(wallet)).refund(url);
      this.forget(wallet);
      return result;
    } finally {
      wallet.busy = false;
    }
  }
}

/**
 * Tests only: forget the process-wide wallet registry and held locks, restore
 * the real sleep, and check the channel layout again on the next read.
 */
export function __resetBatchWalletsForTests(): void {
  registry.wallets.clear();
  sleep = realSleep;
  layoutChecked = undefined;
  releaseHeldLocks();
  registry.locks.clear();
}
