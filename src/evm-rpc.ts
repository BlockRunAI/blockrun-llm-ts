/**
 * Minimal EVM JSON-RPC reads for the payment path.
 *
 * The SDK has always read Base over plain `fetch` (see `LLMClient.getBalance`)
 * rather than pulling in a viem transport: a handful of `eth_call`s is all it
 * needs, and a plain fetch keeps the failover order and timeouts explicit.
 * This module is that same approach, shared, so `getBalance()` and the x402
 * `upto` preflight read the same endpoints in the same order.
 */

/**
 * Public RPCs per CAIP-2 network, tried in order after the env override.
 * A network with no entry (Arc today) has no RPC: callers that need one — the
 * `upto` preflight — treat that as "cannot check" and fall back to `exact`.
 */
const PUBLIC_RPCS: Readonly<Record<string, readonly string[]>> = {
  "eip155:8453": [
    "https://base-rpc.publicnode.com",
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
  ],
  "eip155:84532": ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
};

/** Env var that puts a caller's own RPC first for a network. */
const RPC_ENV: Readonly<Record<string, string>> = {
  "eip155:8453": "BASE_RPC_URL",
  "eip155:84532": "BASE_SEPOLIA_RPC_URL",
};

/** RPC endpoints for a CAIP-2 network: the env override first, then the public list. */
export function evmRpcUrls(network: string): string[] {
  const envName = RPC_ENV[network];
  const configured =
    envName && typeof process !== "undefined" && process.env ? process.env[envName] : undefined;
  return [configured, ...(PUBLIC_RPCS[network] ?? [])].filter(
    (rpc): rpc is string => Boolean(rpc),
  );
}

export interface EthCall {
  to: `0x${string}`;
  data: `0x${string}`;
}

export interface EthCallOptions {
  /** Per-endpoint timeout (ms). Default 2000. */
  timeoutMs?: number;
  /** Stop trying further endpoints once this much time (ms) has passed. Default 4000. */
  deadlineMs?: number;
}

/**
 * Run several `eth_call`s as ONE JSON-RPC batch request (one round trip), with
 * endpoint failover. Every call must succeed on the same endpoint — a partial
 * answer is treated as that endpoint failing — so the results are a consistent
 * read of one node's view. Throws when every endpoint fails or the deadline
 * passes.
 */
export async function ethCallBatch(
  rpcUrls: readonly string[],
  calls: readonly EthCall[],
  options: EthCallOptions = {},
): Promise<`0x${string}`[]> {
  if (rpcUrls.length === 0) throw new Error("no RPC endpoint configured for this network");
  const timeoutMs = options.timeoutMs ?? 2000;
  const deadlineMs = options.deadlineMs ?? 4000;
  const started = Date.now();
  const body = calls.map((call, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, "latest"],
  }));

  let lastError: unknown;
  for (const rpc of rpcUrls) {
    if (Date.now() - started >= deadlineMs) break;
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`RPC returned ${response.status}`);
      const parsed = (await response.json()) as unknown;
      if (!Array.isArray(parsed)) throw new Error("RPC did not answer the batch");
      const byId = new Map<number, unknown>();
      for (const item of parsed as Array<{ id?: unknown; result?: unknown; error?: unknown }>) {
        if (typeof item?.id === "number" && item.error === undefined) byId.set(item.id, item.result);
      }
      return calls.map((_, id) => {
        const result = byId.get(id);
        if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result) || result === "0x") {
          throw new Error(`RPC returned no result for call ${id}`);
        }
        return result as `0x${string}`;
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("RPC deadline passed before any endpoint answered");
}
