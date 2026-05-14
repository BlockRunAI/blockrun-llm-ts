/**
 * Cost logging for BlockRun API calls.
 *
 * Append-only JSONL log at ~/.blockrun/cost_log.jsonl — the canonical
 * x402 settlement ledger. Schema matches what Franklin's AgentClient
 * writes, so analytics and `franklin stats` see one unified stream
 * whether the call came through the SDK or through Franklin's own
 * Anthropic-compatible path.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BLOCKRUN_DIR = path.join(os.homedir(), '.blockrun');
const COST_LOG_FILE = path.join(BLOCKRUN_DIR, 'cost_log.jsonl');

/** Canonical on-wire schema for cost_log.jsonl entries. */
export interface CostEntry {
  /** Unix epoch seconds (float, millisecond precision). */
  ts: number;
  /** API endpoint path, e.g. "/v1/chat/completions". */
  endpoint: string;
  /** Settled USDC amount (USD, 6-decimal precision). */
  cost_usd: number;
  /** Model id when known, e.g. "zai/glm-5-turbo". Optional for non-LLM endpoints. */
  model?: string;
  /** Payer wallet address (EVM 0x... or Solana base58). */
  wallet?: string;
  /** Network identifier — "eip155:8453" for Base mainnet, "solana-mainnet", etc. */
  network?: string;
  /** Caller kind for analytics — "LLMClient", "ImageClient", "AgentClient", ... */
  client_kind?: string;
}

export function logCost(entry: CostEntry): void {
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  } catch { /* ignore */ }

  try {
    fs.appendFileSync(COST_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* ignore */ }
}

export function getCostSummary(): {
  totalUsd: number;
  calls: number;
  byModel: Record<string, number>;
  byEndpoint: Record<string, number>;
} {
  if (!fs.existsSync(COST_LOG_FILE)) {
    return { totalUsd: 0, calls: 0, byModel: {}, byEndpoint: {} };
  }

  let totalUsd = 0;
  let calls = 0;
  const byModel: Record<string, number> = {};
  const byEndpoint: Record<string, number> = {};

  try {
    const content = fs.readFileSync(COST_LOG_FILE, 'utf-8').trim();
    if (!content) return { totalUsd: 0, calls: 0, byModel: {}, byEndpoint: {} };

    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as Partial<CostEntry> & { costUsd?: number };
        // Tolerate the legacy camelCase shape ({timestamp, model, costUsd}).
        const cost = typeof raw.cost_usd === 'number' ? raw.cost_usd : (raw.costUsd ?? 0);
        if (!cost) continue;
        totalUsd += cost;
        calls += 1;
        if (raw.model) byModel[raw.model] = (byModel[raw.model] || 0) + cost;
        if (raw.endpoint) byEndpoint[raw.endpoint] = (byEndpoint[raw.endpoint] || 0) + cost;
      } catch { /* skip malformed lines */ }
    }
  } catch { /* ignore */ }

  return { totalUsd, calls, byModel, byEndpoint };
}
