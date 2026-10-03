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
 * Everything here fails OPEN to `exact`: a missing batch accept, an untrusted
 * operator, a deposit over the cap, a channel that is busy with another
 * request, or a gateway refusal that charged nothing all pay the same request
 * with the `exact` scheme instead. Batch problems can make a call cost what it
 * costs today. They cannot make it fail.
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
import { paths as corePaths } from "@blockrun/core";
import { withDisposition, type PaymentRequired } from "./types";

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
}

/** The outcome of one batch attempt. */
export type BatchAttempt =
  | { kind: "paid"; response: Response; chargedUsd: number }
  | { kind: "fallback"; reason: string };

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
  extra?: { chargedAmount?: unknown };
}
interface PaymentPayloadLike {
  x402Version: number;
  payload?: { type?: string };
}
interface StoredRecord {
  channelConfig: { voucherSigner?: string };
  hasConfirmedState?: boolean;
  pending?: unknown;
  [key: string]: unknown;
}
interface ChannelStorage {
  get(key: string): Promise<StoredRecord | undefined>;
  set(key: string, record: StoredRecord): Promise<void>;
  delete(key: string): Promise<void>;
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
 * registry every copy sees the same wallets (one scheme and one in-flight
 * flag per wallet) and the same held locks.
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
 * Wrap storage so a request a dead process never heard back about cannot
 * wedge the channel.
 *
 * In server-signed mode the scheme refuses a new request while one is pending,
 * and a pending entry is only cleared by that request's response. A process
 * that died mid-request leaves one on disk, and every later process would then
 * refuse batch forever. The channel file is owned by one live process at a
 * time ({@link lockChannelFile}), and that process tracks its own requests in
 * memory, so a pending entry read from disk belongs to a process that is gone.
 *
 * - A pending authorization is dropped and the confirmed state kept. That can
 *   only under-count what was charged, which the next voucher corrects.
 * - A pending DEPOSIT (open or top-up) drops the whole record. The gateway
 *   funds a deposit before it serves anything, so the on-chain deposit may be
 *   larger than the confirmed state says. Keeping the stale figure would let
 *   the next top-up lock more than `maxDeposit`. Without a record, the scheme
 *   reads the real channel from the chain.
 */
export function dropOrphanedPending(storage: ChannelStorage): ChannelStorage {
  return {
    get: async (key) => {
      const record = await storage.get(key);
      if (!record?.pending || record.channelConfig?.voucherSigner !== "server") return record;
      if (!record.hasConfirmedState || pendingDeposit(record.pending)) {
        await storage.delete(key);
        return undefined;
      }
      const { pending: _pending, hasConfirmedState: _confirmed, ...confirmed } = record;
      await storage.set(key, confirmed as StoredRecord);
      return confirmed as StoredRecord;
    },
    set: (key, record) => storage.set(key, record),
    delete: (key) => storage.delete(key),
  };
}

/** True when a 402 offers a batch-settlement accept. */
export function offersBatch(paymentRequired: PaymentRequired): boolean {
  return (paymentRequired.accepts ?? []).some((accept) => accept.scheme === BATCH_SCHEME);
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
 * A gateway answer to a batch payment that charged nothing and asks for
 * `exact` instead: any 402, a `batch_*` refusal (payer not admitted,
 * admission paused, lane unavailable, operator mode required), or the
 * verifier being unreachable (`PAYMENT_VERIFICATION_UNAVAILABLE`).
 */
async function isBatchRefusal(response: Response): Promise<string | undefined> {
  if (response.status === 402) return "payment_required";
  if (![400, 403, 409, 503].includes(response.status)) return undefined;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return undefined;
  }
  const { error, code } = (body ?? {}) as { error?: unknown; code?: unknown };
  if (code === "PAYMENT_VERIFICATION_UNAVAILABLE") return code;
  return typeof error === "string" && error.startsWith("batch_") ? error : undefined;
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
  warned: Set<string>;
}

/**
 * One wallet's batch-settlement payer. Owned by a SolanaLLMClient.
 *
 * At most one batch request is in flight per wallet: the server-signed scheme
 * allows a single pending authorization per channel. Concurrent calls do not
 * queue behind it, they pay with `exact`, so batch never makes a parallel
 * workload slower than it is today.
 */
export class SolanaBatchPayer {
  private state?: Promise<WalletBatch | string>;

  constructor(private readonly init: SolanaBatchPayerInit) {
    const { operators } = init.options;
    if (!Array.isArray(operators) || operators.length === 0 || operators.some((o) => typeof o !== "string" || !o)) {
      throw new Error("batch.operators must list at least one base58 operator public key");
    }
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
  private wallet(): Promise<WalletBatch | string> {
    this.state ??= (async () => {
      const address = await this.init.address();
      const file = await this.storeFile();
      const { operators, maxDeposit } = this.init.options;
      const headers = Object.entries(this.init.rpcHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b));
      const config = JSON.stringify([[...operators].sort(), String(maxDeposit ?? ""), file ?? null, this.init.rpcUrl, headers]);
      const existing = registry.wallets.get(address);
      if (existing) {
        return existing.config === config
          ? existing
          : "another client in this process uses this wallet with different batch options";
      }
      if (file) {
        const owner = lockChannelFile(file);
        if (owner !== undefined) {
          return owner === process.pid
            ? `channel store ${file} is in use by another copy of @blockrun/llm in this process ` +
                `(or by a process that had this pid and died: remove ${file}.lock if nothing uses it)`
            : `channel store ${file} is in use by process ${owner}`;
        }
      }
      const created: WalletBatch = { config, busy: false, warned: new Set() };
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
      const file = await this.storeFile();
      const storage = file ? dropOrphanedPending(new FileChannelStorage(file)) : undefined;
      const scheme = new svm.BatchSvmScheme(signer, {
        rpcUrl: this.init.rpcUrl,
        serverSignedChannelsPolicy: {
          allowedOperators: this.init.options.operators,
          maxDeposit: this.init.options.maxDeposit ?? svm.DEFAULT_SERVER_SIGNED_MAX_DEPOSIT,
        },
        ...(storage ? { channelStorage: storage as never } : {}),
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
  private async forget(wallet: WalletBatch): Promise<void> {
    wallet.client = undefined;
    const file = await this.storeFile();
    if (file) new FileChannelStorage(file).clear();
  }

  private warn(wallet: WalletBatch | undefined, reason: string): void {
    if (wallet?.warned.has(reason)) return;
    wallet?.warned.add(reason);
    console.error(`[@blockrun/llm] batch-settlement unavailable (${reason}); paying with exact`);
  }

  /**
   * Pay one 402 with batch-settlement, or say why the caller should use exact.
   *
   * `send` replays the original request with the payment headers. The
   * returned response is 2xx; any other answer either becomes a fallback (the
   * gateway charged nothing) or is returned to the caller's own error path.
   */
  async pay(
    paymentRequired: PaymentRequired,
    send: (headers: Record<string, string>) => Promise<Response>,
  ): Promise<BatchAttempt | { kind: "failed"; response: Response }> {
    if (!offersBatch(paymentRequired)) return { kind: "fallback", reason: "not_offered" };
    const wallet = await this.wallet();
    if (typeof wallet === "string") {
      this.warn(undefined, wallet);
      return { kind: "fallback", reason: wallet };
    }
    if (wallet.busy) return { kind: "fallback", reason: "channel_busy" };
    wallet.busy = true;
    try {
      let http: HttpPaymentClient;
      let payload: PaymentPayloadLike;
      try {
        http = (await this.build(wallet)).http;
        payload = await http.createPaymentPayload(paymentRequired);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.warn(wallet, reason);
        return { kind: "fallback", reason };
      }
      const deposit = payload.payload?.type === "deposit";

      let response: Response;
      try {
        response = await send(http.encodePaymentSignatureHeader(payload));
      } catch (err) {
        // No answer. A deposit is funded before anything is served, so it may
        // have landed: re-read the channel from the chain rather than restore
        // a deposit figure that could be too low. Otherwise release the
        // pending slot; if the gateway did charge, its next voucher carries it.
        if (deposit) await this.forget(wallet);
        else await this.settle(http, payload, () => null, 0);
        // Sent, so it may have been charged: never retried, never a fallback model.
        throw withDisposition(err, "paid-or-in-doubt");
      }

      const getHeader = (name: string) => response.headers.get(name);
      const settled = await this.settle(http, payload, getHeader, response.status);
      // The same holds for a deposit the gateway answered without a clean
      // receipt: only a confirmed receipt proves what the channel now holds.
      if (deposit && !(response.ok && settled?.success === true)) await this.forget(wallet);
      if (response.ok) {
        return { kind: "paid", response, chargedUsd: chargedUsd(() => http.getPaymentSettleResponse(getHeader)) };
      }
      const refusal = await isBatchRefusal(response);
      if (refusal) {
        this.warn(wallet, refusal);
        return { kind: "fallback", reason: refusal };
      }
      return { kind: "failed", response };
    } finally {
      wallet.busy = false;
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
  ): Promise<SettleResponseLike | undefined> {
    try {
      return (await http.processPaymentResult(payload, getHeader, status)).settleResponse;
    } catch (err) {
      console.error(
        `[@blockrun/llm] batch-settlement receipt not reconciled: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
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
    if (typeof wallet === "string") throw new Error(`batch-settlement unavailable: ${wallet}`);
    if (wallet.busy) throw new Error("batch-settlement channel has a request in flight; close it when the call returns");
    wallet.busy = true;
    try {
      const result = await (await this.build(wallet)).refund(url);
      await this.forget(wallet);
      return result;
    } finally {
      wallet.busy = false;
    }
  }
}

/** Tests only: forget the process-wide wallet registry and held locks. */
export function __resetBatchWalletsForTests(): void {
  registry.wallets.clear();
  releaseHeldLocks();
  registry.locks.clear();
}
