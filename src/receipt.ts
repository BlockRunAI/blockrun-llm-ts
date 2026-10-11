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
 * Attach cost + settlement to a parsed chat response (mutates and returns it).
 *
 * `costUsd` is `bookedUsd`, the amount the client just added to its session
 * spending (`getSpending()`), so the two always agree: the signed price under
 * exact, the receipt's `extra.chargedAmount` under batch. The settlement's
 * transaction / network come from the receipt.
 */
export function withCost<T extends { costUsd?: number; settlement?: Settlement }>(
  body: T,
  response: Response,
  bookedUsd: number,
  scheme: Settlement["scheme"],
): T {
  body.costUsd = bookedUsd;
  body.settlement = readSettlement(response, bookedUsd, scheme).settlement;
  return body;
}
