/**
 * What one paid call actually cost, read from the gateway's PAYMENT-RESPONSE.
 *
 * The x402 receipt header is base64 JSON: `{ success, transaction, network,
 * payer, amount?, extra?: { chargedAmount? } }`. Under batch / metered schemes
 * the real charge is `extra.chargedAmount` (atomic USDC), else `amount`; under
 * `exact` neither is set and the signed quote is the charge. The receipt is
 * decoded best-effort: a missing or malformed header never fails the call.
 *
 * Some gateway routes also (or only) set `X-Payment-Receipt`, whose value is
 * the raw settlement transaction hash, not base64 JSON.
 */
import type { Settlement } from "./types";

/** Atomic USDC (a string of digits, 6 decimals) to USD; undefined for anything else. */
function atomicToUsd(amount: unknown): number | undefined {
  return typeof amount === "string" && /^\d+$/.test(amount) ? Number(amount) / 1e6 : undefined;
}

/**
 * The charge an x402 receipt states, in USD: the metered `extra.chargedAmount`,
 * else a non-empty top-level `amount` (a receipt rebuilt after the gateway
 * confirmed a commit). Undefined when it states none. Never the ceiling.
 * Shared by {@link readSettlement} and the Solana batch payer's booking, so
 * the two cannot disagree on what a call cost.
 */
export function receiptChargedUsd(
  receipt: { amount?: unknown; extra?: { chargedAmount?: unknown } | null } | null | undefined,
): number | undefined {
  return atomicToUsd(receipt?.extra?.chargedAmount) ?? atomicToUsd(receipt?.amount);
}

function decode(header: string): Record<string, unknown> | undefined {
  try {
    const json = typeof Buffer !== "undefined" ? Buffer.from(header, "base64").toString("utf8") : atob(header);
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The cost and settlement for one response.
 *
 * `costUsd` is the charge the receipt states, else `quotedUsd`.
 * @param quotedUsd - what was signed (the exact price, or the batch charge the payer reported).
 * @param scheme - how it was paid.
 */
export function readSettlement(
  response: Response,
  quotedUsd: number,
  scheme: Settlement["scheme"],
): { costUsd: number; settlement: Settlement } {
  const header = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  const receipt = header ? decode(header) : undefined;
  const extra = receipt?.extra;
  const costUsd =
    receiptChargedUsd({
      amount: receipt?.amount,
      extra: extra && typeof extra === "object" ? (extra as { chargedAmount?: unknown }) : undefined,
    }) ?? quotedUsd;
  // X-Payment-Receipt carries the bare transaction hash; use it when the x402
  // receipt names none (or is absent).
  const receiptTx = typeof receipt?.transaction === "string" && receipt.transaction ? receipt.transaction : undefined;
  const transaction = receiptTx ?? (response.headers.get("X-Payment-Receipt")?.trim() || undefined);
  const settlement: Settlement = {
    scheme,
    quotedUsd,
    ...(transaction ? { transaction } : {}),
    ...(typeof receipt?.network === "string" ? { network: receipt.network } : {}),
    ...(receipt?.success === false ? { success: false } : {}),
  };
  return { costUsd, settlement };
}

/**
 * Why the gateway served a paid request WITHOUT settling it, or undefined when
 * it did not say so.
 *
 * The gateway names a skipped settlement two ways:
 * - `X-Settlement-Skipped: <reason>`: `free-fallback` (a free model answered a
 *   paid chat), `empty-result` (a prediction-market search found nothing),
 *   `unexecuted` (a JSON-RPC call that never ran), and any reason added later.
 * - `X-Payment-Waived: <reason>`: the same waiver on routes that do not (yet)
 *   send `X-Settlement-Skipped` (blockrun.ai's `/v1/pm/*` empty result).
 *
 * Either one means the signed payment was never settled. An empty value, or
 * one that says the opposite (`false`, `0`, `no`, `none`), is not a reason and
 * does not count: a call is booked unless the gateway names why it was not
 * charged. Nor does a skip header on a response that proves the payment
 * settled anyway (a successful receipt with a transaction or a positive
 * charge, or an `X-Payment-Receipt` hash): that call is booked, and the
 * conflict logged to stderr.
 *
 * `X-Payment-Settled: false` on its own is NOT a skip: it means settlement did
 * not land before the response went out, and the payment is still owed.
 */
export function settlementSkipReason(response: Response): string | undefined {
  // Read AFTER a payment was sent: a response-like object without headers (a
  // custom fetch) names no skip and must not turn a paid call into a throw.
  const headers = response.headers as Headers | undefined;
  if (typeof headers?.get !== "function") return undefined;
  const reason = [headers.get("X-Settlement-Skipped"), headers.get("X-Payment-Waived")]
    .map((value) => value?.trim())
    .find((value): value is string => !!value && !NOT_A_SKIP.test(value));
  if (reason === undefined) return undefined;
  // Settlement evidence beats a skip header: money that moved is booked.
  const evidence = settlementEvidence(response);
  if (evidence !== undefined) {
    console.error(
      `[@blockrun/llm] settlement: the gateway named a skipped settlement (${JSON.stringify(reason)}) on a response that also carries ${evidence}; booked as charged`,
    );
    return undefined;
  }
  return reason;
}

/** Header values that say settlement was NOT skipped: never a reason. */
const NOT_A_SKIP = /^(false|0|no|none)$/i;

/**
 * Proof in the response that the payment settled anyway: a receipt that
 * succeeded with a transaction or a positive charge, or an
 * `X-Payment-Receipt` transaction hash. Undefined when there is none.
 */
function settlementEvidence(response: Response): string | undefined {
  const header = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  const receipt = header ? decode(header) : undefined;
  if (receipt && receipt.success !== false) {
    if (typeof receipt.transaction === "string" && receipt.transaction) return "a settlement receipt with a transaction";
    const extra = receipt.extra;
    const charged = receiptChargedUsd({
      amount: receipt.amount,
      extra: extra && typeof extra === "object" ? (extra as { chargedAmount?: unknown }) : undefined,
    });
    if (charged !== undefined && charged > 0) return "a settlement receipt with a charge";
  }
  if (response.headers.get("X-Payment-Receipt")?.trim()) return "an X-Payment-Receipt transaction";
  return undefined;
}

/**
 * Whether the gateway skipped settlement for this paid request
 * ({@link settlementSkipReason}). The signed payment was never settled, so
 * nothing was charged and nothing may be booked: every site that adds a paid
 * call to `getSpending()` or the cost log checks this first.
 */
export function settlementSkipped(response: Response): boolean {
  return settlementSkipReason(response) !== undefined;
}

/**
 * Attach cost + settlement to a parsed chat response (mutates and returns it).
 *
 * `costUsd` is `bookedUsd`, the amount the client just added to its session
 * spending (`getSpending()`), so the two always agree: the signed price under
 * exact, the receipt's `extra.chargedAmount` under batch. The settlement's
 * transaction / network come from the receipt. When the gateway skipped
 * settlement ({@link settlementSkipped}) the cost is 0 and the caller must not
 * have booked anything; `bookedUsd` is then only the signed quote.
 */
export function withCost<T extends { costUsd?: number; settlement?: Settlement }>(
  body: T,
  response: Response,
  bookedUsd: number,
  scheme: Settlement["scheme"],
): T {
  const skipped = settlementSkipReason(response);
  if (skipped !== undefined) {
    // Settlement was skipped: the caller booked nothing, and `bookedUsd` is
    // only what was signed.
    body.costUsd = 0;
    body.settlement = { ...readSettlement(response, bookedUsd, scheme).settlement, skipped };
    return body;
  }
  body.costUsd = bookedUsd;
  body.settlement = readSettlement(response, bookedUsd, scheme).settlement;
  return body;
}
