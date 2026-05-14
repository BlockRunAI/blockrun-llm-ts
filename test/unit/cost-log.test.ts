import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logCost, getCostSummary } from '../../src/cost-log.js';

// `src/cost-log.ts` was rewritten to share the on-wire schema with
// Franklin's AgentClient — new path is `~/.blockrun/cost_log.jsonl`,
// new schema uses `ts` / `endpoint` / `cost_usd` instead of the
// previous `timestamp` / `costUsd` / `inputTokens`. These tests track
// the current shape.
const COST_LOG = path.join(os.homedir(), '.blockrun', 'cost_log.jsonl');
const BACKUP = COST_LOG + '.bak';

describe('Cost Log Module', () => {
  beforeEach(() => {
    // Move any real on-disk log out of the way so tests run against an
    // empty file and don't permanently destroy the user's ledger.
    if (fs.existsSync(COST_LOG)) {
      fs.copyFileSync(COST_LOG, BACKUP);
      fs.unlinkSync(COST_LOG);
    }
  });

  afterEach(() => {
    try { fs.unlinkSync(COST_LOG); } catch { /* ignore */ }
    if (fs.existsSync(BACKUP)) {
      fs.renameSync(BACKUP, COST_LOG);
    }
  });

  it('should log a cost entry', () => {
    logCost({
      ts: Date.now() / 1000,
      endpoint: '/v1/chat/completions',
      cost_usd: 0.002,
      model: 'openai/gpt-5.4',
    });

    expect(fs.existsSync(COST_LOG)).toBe(true);
    const content = fs.readFileSync(COST_LOG, 'utf-8').trim();
    const entry = JSON.parse(content);
    expect(entry.model).toBe('openai/gpt-5.4');
    expect(entry.cost_usd).toBe(0.002);
    expect(entry.endpoint).toBe('/v1/chat/completions');
  });

  it('should return empty summary when no logs', () => {
    const summary = getCostSummary();
    expect(summary.totalUsd).toBe(0);
    expect(summary.calls).toBe(0);
    expect(Object.keys(summary.byModel)).toHaveLength(0);
  });

  it('should summarize multiple entries', () => {
    logCost({ ts: 1, endpoint: '/v1/chat/completions', cost_usd: 0.01,  model: 'openai/gpt-5.4' });
    logCost({ ts: 2, endpoint: '/v1/chat/completions', cost_usd: 0.02,  model: 'anthropic/claude-sonnet-4.6' });
    logCost({ ts: 3, endpoint: '/v1/chat/completions', cost_usd: 0.005, model: 'openai/gpt-5.4' });

    const summary = getCostSummary();
    expect(summary.calls).toBe(3);
    expect(summary.totalUsd).toBeCloseTo(0.035);
    expect(summary.byModel['openai/gpt-5.4']).toBeCloseTo(0.015);
    expect(summary.byModel['anthropic/claude-sonnet-4.6']).toBeCloseTo(0.02);
  });
});
