import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logCost, getCostSummary } from '../../src/cost-log.js';

const COST_LOG = path.join(os.homedir(), '.blockrun', 'data', 'costs.jsonl');
const BACKUP = COST_LOG + '.bak';

describe('Cost Log Module', () => {
  beforeEach(() => {
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
      timestamp: '2026-03-22T10:00:00Z',
      model: 'openai/gpt-5.4',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.002,
    });

    expect(fs.existsSync(COST_LOG)).toBe(true);
    const content = fs.readFileSync(COST_LOG, 'utf-8').trim();
    const entry = JSON.parse(content);
    expect(entry.model).toBe('openai/gpt-5.4');
    expect(entry.costUsd).toBe(0.002);
  });

  it('should return empty summary when no logs', () => {
    const summary = getCostSummary();
    expect(summary.totalUsd).toBe(0);
    expect(summary.calls).toBe(0);
    expect(Object.keys(summary.byModel)).toHaveLength(0);
  });

  it('should summarize multiple entries', () => {
    logCost({ timestamp: '', model: 'openai/gpt-5.4', inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    logCost({ timestamp: '', model: 'anthropic/claude-sonnet-4.6', inputTokens: 200, outputTokens: 100, costUsd: 0.02 });
    logCost({ timestamp: '', model: 'openai/gpt-5.4', inputTokens: 50, outputTokens: 25, costUsd: 0.005 });

    const summary = getCostSummary();
    expect(summary.calls).toBe(3);
    expect(summary.totalUsd).toBeCloseTo(0.035);
    expect(summary.byModel['openai/gpt-5.4']).toBeCloseTo(0.015);
    expect(summary.byModel['anthropic/claude-sonnet-4.6']).toBeCloseTo(0.02);
  });
});
