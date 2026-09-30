/**
 * x402 `upto` scheme (Permit2) for EVM, and the exact/upto selection policy.
 *
 * Why: with `exact` the payer signs a fixed pre-call quote, so a cheaper actual
 * call — a prompt-cache hit, a short answer — can never be charged less. With
 * `upto` the payer signs a CEILING and the gateway settles the ACTUAL amount
 * (≤ the ceiling) after the call. blockrun.ai offers `upto` as `accepts[1]`
 * beside `exact` (`accepts[0]`), with `extra.facilitatorAddress`.
 *
 * Semantics match the official client, `@x402/evm` 2.28.0
 * (`createUptoPermit2Payload` + `trySignEip2612PermitExtension`):
 *
 * - The payer signs a Permit2 `PermitWitnessTransferFrom` whose spender is the
 *   x402 upto proxy and whose witness binds `to` (payTo) and `facilitator`.
 *   Permit2 then needs a USDC allowance, which a wallet that has never used
 *   Permit2 does not have.
 * - When the 402 declares `extensions.eip2612GasSponsoring`, the payer can
 *   instead sign a USDC EIP-2612 `Permit` to Permit2 and the facilitator
 *   submits it — so a wallet holding NO ETH can still use `upto`.
 *
 * Two deliberate differences from the reference, both in the direction of
 * signing less:
 *
 * - The EIP-2612 domain is the SDK's own value for the network (EVM_NETWORKS),
 *   never the 402's `extra`, and the asset must be that network's USDC — the
 *   same rule the `exact` signer enforces.
 * - Any RPC failure means `exact`, where the reference signs the permit anyway.
 *
 * The private key is used ONLY for local signing and NEVER leaves the client.
 */

import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, toHex } from "viem";
import { signTypedData } from "viem/accounts";
import type { PaymentRequired, PaymentScheme } from "./types";
import {
  EVM_NETWORKS,
  createPaymentPayload,
  extractPaymentDetails,
  withBuilderCodeServiceCode,
  type EvmNetwork,
} from "./x402";
import { ethCallBatch, evmRpcUrls } from "./evm-rpc";

/** Canonical Uniswap Permit2 — same address on every EVM chain. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** The x402 upto Permit2 proxy: the `spender` of every upto authorization. */
export const X402_UPTO_PERMIT2_PROXY_ADDRESS = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002" as const;

/** Extension key a 402 uses to declare that the facilitator sponsors EIP-2612 approvals. */
export const EIP2612_GAS_SPONSORING_KEY = "eip2612GasSponsoring";

/** EIP-712 types for the upto Permit2 witness transfer (@x402/evm `uptoPermit2WitnessTypes`). */
export const UPTO_PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

/** EIP-712 types for an EIP-2612 `Permit` (@x402/evm `eip2612PermitTypes`). */
export const EIP2612_PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const ERC20_READ_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nonces",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/** Random 256-bit Permit2 nonce as a decimal string (@x402/evm `createPermit2Nonce`). */
export function createPermit2Nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(toHex(bytes)).toString();
}

/** An `upto` option from a 402, validated and resolved against the SDK's network table. */
export interface UptoRequirement {
  network: string;
  net: EvmNetwork;
  /** Ceiling in atomic USDC units (6 decimals). */
  amount: string;
  payTo: `0x${string}`;
  facilitatorAddress: `0x${string}`;
  maxTimeoutSeconds: number;
}

/**
 * The 402's usable `upto` option on `network`, or null.
 *
 * Usable means: an EVM network in EVM_NETWORKS (the same network the `exact`
 * option is on — `auto` never switches chains), a positive integer amount,
 * the network's own USDC as asset, an address payTo, and an address
 * `extra.facilitatorAddress` (without it the witness cannot be built).
 */
export function findUptoRequirement(
  paymentRequired: PaymentRequired,
  network: string,
): UptoRequirement | null {
  const net = EVM_NETWORKS[network];
  if (!net) return null;
  for (const opt of paymentRequired.accepts || []) {
    if (opt?.scheme !== "upto" || opt.network !== network) continue;
    const amount = opt.amount || opt.maxAmountRequired;
    const facilitator = opt.extra?.facilitatorAddress;
    if (!amount || !/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) continue;
    if (!opt.asset || opt.asset.toLowerCase() !== net.usdc.toLowerCase()) continue;
    if (!opt.payTo || !isAddress(opt.payTo, { strict: false })) continue;
    if (typeof facilitator !== "string" || !isAddress(facilitator, { strict: false })) continue;
    const maxTimeoutSeconds = opt.maxTimeoutSeconds || 300;
    if (!(maxTimeoutSeconds > 0)) continue;
    return {
      network,
      net,
      amount,
      payTo: opt.payTo as `0x${string}`,
      facilitatorAddress: facilitator as `0x${string}`,
      maxTimeoutSeconds,
    };
  }
  return null;
}

export interface Permit2Authorization {
  from: string;
  permitted: { token: string; amount: string };
  spender: string;
  nonce: string;
  deadline: string;
  witness: { to: string; facilitator: string; validAfter: string };
}

/**
 * Sign the upto Permit2 witness transfer (@x402/evm `createUptoPermit2Payload`).
 * `nonce` / `nowSeconds` are injectable for deterministic tests.
 */
export async function signUptoPermit2Authorization(
  privateKey: `0x${string}`,
  fromAddress: string,
  upto: UptoRequirement,
  opts: { nonce?: string; nowSeconds?: number } = {},
): Promise<{ signature: `0x${string}`; permit2Authorization: Permit2Authorization }> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? createPermit2Nonce();
  const validAfter = "0";
  const deadline = (now + upto.maxTimeoutSeconds).toString();
  const permit2Authorization: Permit2Authorization = {
    from: fromAddress,
    permitted: { token: getAddress(upto.net.usdc), amount: upto.amount },
    spender: X402_UPTO_PERMIT2_PROXY_ADDRESS,
    nonce,
    deadline,
    witness: {
      to: getAddress(upto.payTo),
      facilitator: getAddress(upto.facilitatorAddress),
      validAfter,
    },
  };
  const signature = await signTypedData({
    privateKey,
    domain: { name: "Permit2", chainId: upto.net.chainId, verifyingContract: PERMIT2_ADDRESS },
    types: UPTO_PERMIT2_WITNESS_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: {
        token: getAddress(permit2Authorization.permitted.token),
        amount: BigInt(permit2Authorization.permitted.amount),
      },
      spender: getAddress(permit2Authorization.spender),
      nonce: BigInt(permit2Authorization.nonce),
      deadline: BigInt(permit2Authorization.deadline),
      witness: {
        to: getAddress(permit2Authorization.witness.to),
        facilitator: getAddress(permit2Authorization.witness.facilitator),
        validAfter: BigInt(permit2Authorization.witness.validAfter),
      },
    },
  });
  return { signature, permit2Authorization };
}

/** The `eip2612GasSponsoring.info` object (@x402/evm `signEip2612Permit`). */
export interface Eip2612GasSponsoringInfo {
  from: string;
  asset: string;
  spender: string;
  amount: string;
  nonce: string;
  deadline: string;
  signature: `0x${string}`;
  version: "1";
}

/**
 * Sign a USDC EIP-2612 `Permit` granting Permit2 `amount`, for the facilitator
 * to submit. The domain is the SDK's own for the network, never the 402's.
 *
 * `amount` MUST be the upto authorization's `permitted.amount` (the per-call
 * ceiling) — see assertPermitMatchesPermitted. Not MaxUint256.
 */
export async function signEip2612GasSponsoringPermit(
  privateKey: `0x${string}`,
  ownerAddress: string,
  net: EvmNetwork,
  amount: string,
  tokenNonce: bigint,
  deadline: string,
): Promise<Eip2612GasSponsoringInfo> {
  const owner = getAddress(ownerAddress);
  const spender = getAddress(PERMIT2_ADDRESS);
  const tokenAddress = getAddress(net.usdc);
  const value = BigInt(amount);
  const signature = await signTypedData({
    privateKey,
    domain: {
      name: net.domain.name,
      version: net.domain.version,
      chainId: net.chainId,
      verifyingContract: tokenAddress,
    },
    types: EIP2612_PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner, spender, value, nonce: tokenNonce, deadline: BigInt(deadline) },
  });
  return {
    from: owner,
    asset: tokenAddress,
    spender,
    amount: value.toString(),
    nonce: tokenNonce.toString(),
    deadline,
    signature,
    version: "1",
  };
}

/**
 * The x402 upto proxy executes the sponsored permit only if its value equals
 * the Permit2 authorization's permitted amount —
 * x402BasePermit2Proxy.sol `_executePermit` (Base 0x4020A4f3…0002, verified on
 * Sourcify): `if (permit2612.value != permittedAmount) revert Permit2612AmountMismatch();`
 * A MaxUint256 permit was tried live on 2026-09-30 and CDP verify rejected it
 * (simulation failed, invalid_exact_evm_permit2_payload_allowance_required).
 * Refuse to emit a payload the proxy would revert.
 */
export function assertPermitMatchesPermitted(
  info: Pick<Eip2612GasSponsoringInfo, "amount">,
  permit2Authorization: Pick<Permit2Authorization, "permitted">,
): void {
  if (info.amount !== permit2Authorization.permitted.amount) {
    throw new Error(
      `EIP-2612 permit value ${info.amount} must equal the Permit2 permitted amount ` +
        `${permit2Authorization.permitted.amount} (x402 upto proxy: Permit2612AmountMismatch)`,
    );
  }
}

export interface CreateUptoPaymentOptions {
  resourceUrl?: string;
  resourceDescription?: string;
  /** The 402's extensions; echoed like `exact` does (plus BlockRun's builder code). */
  extensions?: Record<string, unknown>;
  /** When set, attach an EIP-2612 gas-sponsoring permit signed at this USDC nonce. */
  gasSponsoringTokenNonce?: bigint;
  /** Test seams. */
  permit2Nonce?: string;
  nowSeconds?: number;
}

/**
 * Build the base64 x402 v2 `upto` payment payload. The envelope mirrors the
 * `exact` one (`resource`, `accepted`, `payload`, `extensions`) with
 * `accepted.scheme = "upto"` and the facilitator in `accepted.extra`.
 */
export async function createUptoPaymentPayload(
  privateKey: `0x${string}`,
  fromAddress: string,
  upto: UptoRequirement,
  options: CreateUptoPaymentOptions = {},
): Promise<string> {
  const { signature, permit2Authorization } = await signUptoPermit2Authorization(
    privateKey,
    fromAddress,
    upto,
    { nonce: options.permit2Nonce, nowSeconds: options.nowSeconds },
  );

  // The server's eip2612GasSponsoring entry is a DECLARATION (schema/description),
  // not a permit. Echoing it back would put an info-less permit object in front
  // of the facilitator, so it is replaced by our signed permit or dropped.
  const echoed: Record<string, unknown> = { ...(options.extensions || {}) };
  delete echoed[EIP2612_GAS_SPONSORING_KEY];
  const extensions = withBuilderCodeServiceCode(echoed);
  if (options.gasSponsoringTokenNonce !== undefined) {
    const info = await signEip2612GasSponsoringPermit(
      privateKey,
      fromAddress,
      upto.net,
      permit2Authorization.permitted.amount,
      options.gasSponsoringTokenNonce,
      permit2Authorization.deadline,
    );
    assertPermitMatchesPermitted(info, permit2Authorization);
    extensions[EIP2612_GAS_SPONSORING_KEY] = { info };
  }

  const paymentData = {
    x402Version: 2,
    resource: {
      url: options.resourceUrl || "https://blockrun.ai/api/v1/chat/completions",
      description: options.resourceDescription || "BlockRun AI API call",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "upto",
      network: upto.network,
      amount: upto.amount,
      asset: upto.net.usdc,
      payTo: upto.payTo,
      maxTimeoutSeconds: upto.maxTimeoutSeconds,
      extra: {
        name: upto.net.domain.name,
        version: upto.net.domain.version,
        facilitatorAddress: upto.facilitatorAddress,
      },
    },
    payload: { signature, permit2Authorization },
    extensions,
  };
  return btoa(JSON.stringify(paymentData));
}

/** What the upto preflight decided. */
export type UptoPlan =
  | { use: true; gasSponsoringTokenNonce?: bigint; pendingResolved?: boolean }
  | { use: false; reason: string; pendingResolved?: boolean };

/**
 * A gas-sponsored permit this client signed and has not yet seen consumed.
 *
 * Each gas-sponsored upto call carries its OWN permit, valued at that call's
 * ceiling (the proxy requires it — see assertPermitMatchesPermitted), and the
 * transfer spends that allowance, so the next call needs another permit at
 * the next USDC nonce. Until the previous one has executed, a new permit would
 * reuse its nonce: on 2026-09-30 call 2, signed ~2s after call 1 while call 1
 * was still settling asynchronously, read nonce 0 again and reverted on-chain.
 * So per wallet at most ONE gas-sponsored upto payment can be in flight.
 */
export interface PendingPermit {
  /** The USDC EIP-2612 nonce the permit was signed at. */
  tokenNonce: bigint;
  /** The permit's deadline (unix seconds). Past it, it can never execute. */
  deadline: number;
}

/**
 * Decide whether this wallet can pay `upto` right now, with ONE batched RPC
 * round trip: USDC balance, USDC allowance to Permit2, and (only when the 402
 * declares gas sponsoring) the USDC EIP-2612 nonce.
 *
 * - balance < ceiling → no: the ceiling is what gets verified, and a wallet
 *   that can afford the `exact` quote but not the ceiling must stay on exact.
 * - allowance ≥ ceiling → yes, no permit.
 * - allowance short + gas sponsoring declared → yes, with a permit at the
 *   on-chain USDC nonce — unless `pending` (a permit this client signed) is
 *   still live: on-chain nonce <= its nonce and now < its deadline. Then no:
 *   a second permit would reuse or race the same nonce.
 * - otherwise → no.
 *
 * `pendingResolved` reports that `pending` can be forgotten: the on-chain
 * nonce moved past it (consumed) or its deadline passed (can never execute).
 * Allowance ≥ ceiling means upto without a permit regardless of `pending`.
 *
 * `permitBlocked`: a concurrent call from the same client holds the permit
 * slot (it reserved it before its own RPC read), so this call must not sign a
 * permit — upto without one if allowance ≥ ceiling, else exact.
 * Any RPC error propagates; the caller turns it into `exact`.
 */
export async function planUpto(
  owner: string,
  upto: UptoRequirement,
  gasSponsoring: boolean,
  rpcUrls: readonly string[] = evmRpcUrls(upto.network),
  pending?: PendingPermit,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  permitBlocked = false,
): Promise<UptoPlan> {
  if (rpcUrls.length === 0) return { use: false, reason: `no RPC for ${upto.network}` };
  const ownerAddr = getAddress(owner);
  const token = upto.net.usdc;
  const calls = [
    { to: token, data: encodeFunctionData({ abi: ERC20_READ_ABI, functionName: "balanceOf", args: [ownerAddr] }) },
    {
      to: token,
      data: encodeFunctionData({ abi: ERC20_READ_ABI, functionName: "allowance", args: [ownerAddr, PERMIT2_ADDRESS] }),
    },
  ];
  if (gasSponsoring) {
    calls.push({ to: token, data: encodeFunctionData({ abi: ERC20_READ_ABI, functionName: "nonces", args: [ownerAddr] }) });
  }
  const results = await ethCallBatch(rpcUrls, calls);
  const balance = decodeFunctionResult({ abi: ERC20_READ_ABI, functionName: "balanceOf", data: results[0] });
  const allowance = decodeFunctionResult({ abi: ERC20_READ_ABI, functionName: "allowance", data: results[1] });
  const ceiling = BigInt(upto.amount);
  const tokenNonce = gasSponsoring
    ? decodeFunctionResult({ abi: ERC20_READ_ABI, functionName: "nonces", data: results[2] })
    : undefined;
  const pendingResolved =
    pending !== undefined &&
    (nowSeconds >= pending.deadline || (tokenNonce !== undefined && tokenNonce > pending.tokenNonce));
  const livePending = pending !== undefined && !pendingResolved;

  if (balance < ceiling) {
    return { use: false, reason: `USDC balance ${balance} is below the upto ceiling ${ceiling}`, pendingResolved };
  }
  if (allowance >= ceiling) return { use: true, pendingResolved };
  if (tokenNonce === undefined) {
    return { use: false, reason: `Permit2 allowance ${allowance} is below ${ceiling} and the 402 offers no gas sponsoring`, pendingResolved };
  }
  if (permitBlocked) {
    return {
      use: false,
      reason: `another call from this client holds the permit slot (allowance ${allowance} < ${ceiling})`,
      pendingResolved,
    };
  }
  if (livePending) {
    return {
      use: false,
      reason: `a gas-sponsored permit at USDC nonce ${pending!.tokenNonce} is still pending (on-chain nonce ${tokenNonce})`,
    };
  }
  return { use: true, gasSponsoringTokenNonce: tokenNonce, pendingResolved };
}

/** Resolve the effective scheme preference: explicit option, then BLOCKRUN_PAYMENT_SCHEME, then "auto". */
export function resolvePaymentScheme(option?: string): PaymentScheme {
  if (option !== undefined) {
    if (option !== "exact" && option !== "auto") {
      throw new Error(`paymentScheme must be "exact" or "auto", got ${JSON.stringify(option)}`);
    }
    return option;
  }
  const env = typeof process !== "undefined" && process.env ? process.env.BLOCKRUN_PAYMENT_SCHEME : undefined;
  return env?.trim().toLowerCase() === "exact" ? "exact" : "auto";
}

function debug(message: string): void {
  if (typeof process !== "undefined" && process.env?.BLOCKRUN_DEBUG) {
    console.debug(`[@blockrun/llm] x402: ${message}`);
  }
}

export interface CreateEvmPaymentOptions {
  resourceUrl: string;
  resourceDescription: string;
  paymentScheme?: PaymentScheme;
  /** Override the RPC list used for the upto preflight (tests, custom nodes). */
  rpcUrls?: readonly string[];
  /**
   * A gas-sponsoring permit this caller signed for this wallet+network and has
   * not seen consumed. While it is live, a short allowance signs `exact`
   * instead of a second permit (see PendingPermit).
   */
  pendingPermit?: PendingPermit;
  /**
   * Another concurrent call holds this wallet+network's permit slot: never
   * attach a permit (upto only if allowance already ≥ ceiling, else exact).
   */
  permitBlocked?: boolean;
}

export interface SignedEvmPayment {
  /** Base64 value for the PAYMENT-SIGNATURE header. */
  paymentPayload: string;
  scheme: "exact" | "upto";
  /**
   * Atomic USDC authorized. For `exact` this is what settles; for `upto` it
   * is the CEILING — the settled amount is at most this.
   */
  amount: string;
  network: string;
  /** True when an EIP-2612 gas-sponsoring permit rides along. */
  gasSponsored: boolean;
  /** The permit that rides along, to pass back as `pendingPermit` next time. */
  permit?: PendingPermit;
  /** The preflight saw `pendingPermit` consumed or expired: forget it. */
  pendingPermitResolved?: boolean;
}

/**
 * Sign an EVM x402 payment for a parsed 402, choosing the scheme.
 *
 * `upto` is signed only when ALL hold: the preference is "auto"; the 402
 * offers a usable upto option on the exact option's network (with
 * `extra.facilitatorAddress`); the preflight RPC answers; the balance covers
 * the ceiling; and either the Permit2 allowance already covers it or the 402
 * declares `eip2612GasSponsoring`. Anything else — including ANY error while
 * reading or signing upto — signs `exact` exactly as before this existed.
 * Errors from the `exact` signer itself (unsupported network, asset mismatch)
 * still throw, as they always did.
 */
export async function createEvmPayment(
  privateKey: `0x${string}`,
  fromAddress: string,
  paymentRequired: PaymentRequired,
  options: CreateEvmPaymentOptions,
): Promise<SignedEvmPayment> {
  const details = extractPaymentDetails(paymentRequired);
  const network = details.network || "eip155:8453";
  const extensions = paymentRequired.extensions;

  const signExact = async (): Promise<SignedEvmPayment> => ({
    paymentPayload: await createPaymentPayload(privateKey, fromAddress, details.recipient, details.amount, network, {
      resourceUrl: options.resourceUrl,
      resourceDescription: options.resourceDescription,
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra,
      asset: details.asset,
      extensions,
    }),
    scheme: "exact",
    amount: details.amount,
    network,
    gasSponsored: false,
  });

  if ((options.paymentScheme ?? "auto") === "exact") return signExact();
  const upto = findUptoRequirement(paymentRequired, network);
  if (!upto) {
    if (paymentRequired.accepts?.some((o) => o?.scheme === "upto")) {
      debug("402 offers upto but no usable option (network/asset/payTo/facilitatorAddress); signing exact");
    }
    return signExact();
  }

  try {
    const gasSponsoring = Boolean(extensions && extensions[EIP2612_GAS_SPONSORING_KEY]);
    const plan = await planUpto(
      fromAddress,
      upto,
      gasSponsoring,
      options.rpcUrls ?? evmRpcUrls(network),
      options.pendingPermit,
      Math.floor(Date.now() / 1000),
      options.permitBlocked ?? false,
    );
    if (!plan.use) {
      debug(`${plan.reason}; signing exact`);
      return { ...(await signExact()), pendingPermitResolved: plan.pendingResolved };
    }
    const paymentPayload = await createUptoPaymentPayload(privateKey, fromAddress, upto, {
      resourceUrl: options.resourceUrl,
      resourceDescription: options.resourceDescription,
      extensions,
      gasSponsoringTokenNonce: plan.gasSponsoringTokenNonce,
    });
    const permit =
      plan.gasSponsoringTokenNonce !== undefined
        ? {
            tokenNonce: plan.gasSponsoringTokenNonce,
            deadline: Number(JSON.parse(atob(paymentPayload)).payload.permit2Authorization.deadline),
          }
        : undefined;
    return {
      paymentPayload,
      scheme: "upto",
      amount: upto.amount,
      network,
      gasSponsored: permit !== undefined,
      permit,
      pendingPermitResolved: plan.pendingResolved,
    };
  } catch (e) {
    debug(`upto preflight/signing failed (${e instanceof Error ? e.message : String(e)}); signing exact`);
    return signExact();
  }
}

/**
 * Atomic USDC the gateway reports it settled, from the x402 v2
 * PAYMENT-RESPONSE header (or legacy X-PAYMENT-RESPONSE): base64 JSON whose
 * `amount` is what the facilitator's upto settle returned. Null when absent or
 * malformed. Never throws.
 */
export function parseSettledAmount(response: { headers?: { get?: (name: string) => string | null } }): string | null {
  try {
    const get = response.headers?.get?.bind(response.headers);
    if (!get) return null;
    const header = get("payment-response") || get("x-payment-response");
    if (!header) return null;
    const parsed = JSON.parse(atob(header)) as { amount?: unknown };
    const amount = typeof parsed.amount === "number" ? String(parsed.amount) : parsed.amount;
    return typeof amount === "string" && /^[0-9]+$/.test(amount) ? amount : null;
  } catch {
    return null;
  }
}

/**
 * What to book for a paid call. `exact` books the signed amount (that is what
 * settles). `upto` books the gateway-reported settled amount when present
 * (capped at the ceiling), else the ceiling with `basis: "ceiling"` so no
 * ledger mistakes an authorization for a payment.
 */
export function bookedCost(
  signed: Pick<SignedEvmPayment, "scheme" | "amount">,
  response?: { headers?: { get?: (name: string) => string | null } },
): { costUsd: number; basis: "exact" | "settled" | "ceiling" } {
  if (signed.scheme !== "upto") return { costUsd: parseFloat(signed.amount) / 1e6, basis: "exact" };
  const settled = response ? parseSettledAmount(response) : null;
  if (settled !== null) {
    const capped = BigInt(settled) > BigInt(signed.amount) ? signed.amount : settled;
    return { costUsd: parseFloat(capped) / 1e6, basis: "settled" };
  }
  return { costUsd: parseFloat(signed.amount) / 1e6, basis: "ceiling" };
}
