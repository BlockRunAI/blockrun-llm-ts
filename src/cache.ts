/**
 * Local response cache and archive for paid BlockRun API calls.
 *
 * Two storage layers:
 * 1. **Cache** (~/.blockrun/cache/) — hash-keyed, TTL-based dedup to avoid paying twice
 * 2. **Data**  (~/.blockrun/data/)  — human-readable JSON files for every paid call
 *
 * Cache keys are based on (endpoint, request body).
 * TTL is configurable per endpoint type.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const CACHE_DIR = path.join(os.homedir(), '.blockrun', 'cache');
const DATA_DIR = path.join(os.homedir(), '.blockrun', 'data');
const COST_LOG_FILE = path.join(os.homedir(), '.blockrun', 'cost_log.jsonl');

interface CacheEntry {
  cachedAt: number;
  endpoint: string;
  body: Record<string, unknown>;
  response: unknown;
  costUsd: number;
}

const DEFAULT_TTL: Record<string, number> = {
  '/v1/x/': 3600 * 1000,
  '/v1/partner/': 3600 * 1000,
  '/v1/pm/': 1800 * 1000,
  '/v1/chat/': 0,
  '/v1/search': 900 * 1000,
  '/v1/image': 0,
  '/v1/models': 86400 * 1000,
};

function getTtl(endpoint: string): number {
  for (const [pattern, ttl] of Object.entries(DEFAULT_TTL)) {
    if (endpoint.includes(pattern)) return ttl;
  }
  return 3600 * 1000;
}

function cacheKey(endpoint: string, body: Record<string, unknown>): string {
  const keyData = JSON.stringify({ endpoint, body }, Object.keys({ endpoint, body }).sort());
  return crypto.createHash('sha256').update(keyData).digest('hex').slice(0, 16);
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

export function getCached(key: string): unknown | null {
  const filePath = cachePath(key);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry = JSON.parse(raw);
    const ttl = entry.ttlMs ?? getTtl(entry.endpoint ?? '');
    if (ttl <= 0) return null;
    if (Date.now() - entry.cachedAt > ttl) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    return entry.response;
  } catch {
    return null;
  }
}

export function getCachedByRequest(
  endpoint: string,
  body: Record<string, unknown>
): unknown | null {
  const ttl = getTtl(endpoint);
  if (ttl <= 0) return null;
  const key = cacheKey(endpoint, body);
  return getCached(key);
}

export function setCache(key: string, data: unknown, ttlMs: number): void {
  if (ttlMs <= 0) return;

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch { /* ignore */ }

  const entry = {
    cachedAt: Date.now(),
    response: data,
    ttlMs,
  };

  try {
    fs.writeFileSync(cachePath(key), JSON.stringify(entry));
  } catch { /* ignore */ }
}

/**
 * Generate a human-readable filename from endpoint + request body.
 *
 * Examples:
 *   x_search_2026-03-13_123456_x402_payment.json
 *   chat_2026-03-13_123456_gpt-5.2.json
 *   x_followers_2026-03-13_123456_elonmusk.json
 */
function readableFilename(endpoint: string, body: Record<string, unknown>): string {
  const now = new Date();
  const ts = now.toISOString().slice(0, 10) + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');

  // Extract a short label from the endpoint
  let ep = endpoint.replace(/\/+$/, '').split('/').pop() || '';
  if (endpoint.includes('/v1/chat/')) {
    ep = 'chat';
  } else if (endpoint.includes('/v1/x/')) {
    ep = 'x_' + ep;
  } else if (endpoint.includes('/v1/search')) {
    ep = 'search';
  } else if (endpoint.includes('/v1/image')) {
    ep = 'image';
  }

  // Extract a short identifier from the body
  let label = (
    (body.query as string) ||
    (body.username as string) ||
    (body.handle as string) ||
    (body.model as string) ||
    (typeof body.prompt === 'string' ? (body.prompt as string).slice(0, 40) : '') ||
    ''
  );
  // Sanitize for filesystem
  label = String(label).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40).replace(/^_+|_+$/g, '');

  return label ? `${ep}_${ts}_${label}.json` : `${ep}_${ts}.json`;
}

function saveReadable(
  endpoint: string,
  body: Record<string, unknown>,
  response: unknown,
  costUsd: number
): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* ignore */ }

  const filename = readableFilename(endpoint, body);
  const entry = {
    saved_at: new Date().toISOString(),
    endpoint,
    cost_usd: costUsd,
    request: body,
    response,
  };

  try {
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(entry, null, 2));
  } catch { /* ignore */ }
}

function appendCostLog(endpoint: string, costUsd: number): void {
  if (costUsd <= 0) return;

  try {
    fs.mkdirSync(path.dirname(COST_LOG_FILE), { recursive: true });
  } catch { /* ignore */ }

  const entry = {
    ts: Date.now() / 1000,
    endpoint,
    cost_usd: costUsd,
  };

  try {
    fs.appendFileSync(COST_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* ignore */ }
}

export function saveToCache(
  endpoint: string,
  body: Record<string, unknown>,
  response: unknown,
  costUsd: number = 0
): void {
  // Hash-keyed cache (only if TTL > 0)
  const ttl = getTtl(endpoint);
  if (ttl > 0) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch { /* ignore */ }

    const key = cacheKey(endpoint, body);
    const entry: CacheEntry = {
      cachedAt: Date.now(),
      endpoint,
      body,
      response,
      costUsd,
    };

    try {
      fs.writeFileSync(cachePath(key), JSON.stringify(entry));
    } catch { /* ignore */ }
  }

  // Human-readable archive (always, regardless of TTL)
  saveReadable(endpoint, body, response, costUsd);

  // Cost log (always, regardless of TTL)
  appendCostLog(endpoint, costUsd);
}

export function clearCache(): number {
  if (!fs.existsSync(CACHE_DIR)) return 0;

  let count = 0;
  try {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(CACHE_DIR, file));
          count++;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return count;
}

export function getCostLogSummary(): {
  totalUsd: number;
  calls: number;
  byEndpoint: Record<string, number>;
} {
  if (!fs.existsSync(COST_LOG_FILE)) {
    return { totalUsd: 0, calls: 0, byEndpoint: {} };
  }

  let totalUsd = 0;
  let calls = 0;
  const byEndpoint: Record<string, number> = {};

  try {
    const content = fs.readFileSync(COST_LOG_FILE, 'utf-8').trim();
    if (!content) return { totalUsd: 0, calls: 0, byEndpoint: {} };

    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const cost = entry.cost_usd ?? 0;
        const ep = entry.endpoint ?? 'unknown';
        totalUsd += cost;
        calls += 1;
        byEndpoint[ep] = (byEndpoint[ep] || 0) + cost;
      } catch { /* skip malformed lines */ }
    }
  } catch { /* ignore */ }

  return { totalUsd, calls, byEndpoint };
}
