/**
 * What one paid call actually cost, read from the gateway's PAYMENT-RESPONSE.
 *
 * The x402 receipt header is base64 JSON: `{ success, transaction, network,
 * payer, amount?, extra?: { chargedAmount? } }`. Under batch / metered schemes
 * the real charge is `extra.chargedAmount` (atomic USDC), else `amount`; under
 * `exact` neither is set and the signed quote is the charge. The receipt is
 * decoded best-effort: a missing or malformed header never fails the call.
 */
import type { Settlement } from "./types";

function atomicToUsd(amount: unknown): number | undefined {
  if (typeof amount === "string" && /^\d+$/.test(amount)) return Number(amount) / 1e6;
  if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) return amount / 1e6;
  return undefined;
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
 * @param quotedUsd - what was signed (the exact price, or the batch charge the payer reported).
 * @param scheme - how it was paid.
 */
export function readSettlement(
  response: Response,
  quotedUsd: number,
  scheme: Settlement["scheme"],
): { costUsd: number; settlement: Settlement } {
  const header =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE") ?? response.headers.get("X-Payment-Receipt");
  const receipt = header ? decode(header) : undefined;
  const extra = (receipt?.extra ?? {}) as Record<string, unknown>;
  const charged = atomicToUsd(extra.chargedAmount) ?? atomicToUsd(receipt?.amount);
  const costUsd = charged ?? quotedUsd;
  const settlement: Settlement = {
    scheme,
    quotedUsd,
    ...(typeof receipt?.transaction === "string" && receipt.transaction ? { transaction: receipt.transaction } : {}),
    ...(typeof receipt?.network === "string" ? { network: receipt.network } : {}),
    ...(receipt?.success === false ? { success: false } : {}),
  };
  return { costUsd, settlement };
}

/** Attach cost + settlement to a parsed chat response (mutates and returns it). */
export function withCost<T extends { costUsd?: number; settlement?: Settlement }>(
  body: T,
  response: Response,
  quotedUsd: number,
  scheme: Settlement["scheme"],
): T {
  const { costUsd, settlement } = readSettlement(response, quotedUsd, scheme);
  body.costUsd = costUsd;
  body.settlement = settlement;
  return body;
}
