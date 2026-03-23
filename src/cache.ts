/**
 * Local response cache for BlockRun API calls.
 *
 * Hash-keyed, TTL-based dedup to avoid paying twice for identical requests.
 * Cache dir: ~/.blockrun/cache/
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const CACHE_DIR = path.join(os.homedir(), '.blockrun', 'cache');

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
    const entry: CacheEntry = JSON.parse(raw);
    const ttl = getTtl(entry.endpoint);
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

export function saveToCache(
  endpoint: string,
  body: Record<string, unknown>,
  response: unknown,
  costUsd: number = 0
): void {
  const ttl = getTtl(endpoint);
  if (ttl <= 0) return;

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
