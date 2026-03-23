/**
 * Cost logging for BlockRun API calls.
 *
 * Append-only JSONL log at ~/.blockrun/data/costs.jsonl
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DATA_DIR = path.join(os.homedir(), '.blockrun', 'data');
const COST_LOG_FILE = path.join(DATA_DIR, 'costs.jsonl');

export interface CostEntry {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function logCost(entry: CostEntry): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* ignore */ }

  try {
    fs.appendFileSync(COST_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* ignore */ }
}

export function getCostSummary(): {
  totalUsd: number;
  calls: number;
  byModel: Record<string, number>;
} {
  if (!fs.existsSync(COST_LOG_FILE)) {
    return { totalUsd: 0, calls: 0, byModel: {} };
  }

  let totalUsd = 0;
  let calls = 0;
  const byModel: Record<string, number> = {};

  try {
    const content = fs.readFileSync(COST_LOG_FILE, 'utf-8').trim();
    if (!content) return { totalUsd: 0, calls: 0, byModel: {} };

    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const entry: CostEntry = JSON.parse(line);
        totalUsd += entry.costUsd;
        calls += 1;
        byModel[entry.model] = (byModel[entry.model] || 0) + entry.costUsd;
      } catch { /* skip malformed lines */ }
    }
  } catch { /* ignore */ }

  return { totalUsd, calls, byModel };
}
