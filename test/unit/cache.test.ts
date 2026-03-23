import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCached, setCache, saveToCache, getCachedByRequest, clearCache } from '../../src/cache.js';

const CACHE_DIR = path.join(os.homedir(), '.blockrun', 'cache');
const TEST_KEY = '__test_cache_key__';

describe('Cache Module', () => {
  afterEach(() => {
    const filePath = path.join(CACHE_DIR, `${TEST_KEY}.json`);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  });

  describe('setCache + getCached', () => {
    it('should store and retrieve cached data', () => {
      const data = { message: 'hello' };
      setCache(TEST_KEY, data, 60000);
      const result = getCached(TEST_KEY);
      expect(result).toEqual(data);
    });

    it('should return null for non-existent key', () => {
      expect(getCached('nonexistent_key_xyz')).toBeNull();
    });

    it('should not cache when ttl is 0', () => {
      setCache(TEST_KEY, { data: 'test' }, 0);
      expect(getCached(TEST_KEY)).toBeNull();
    });
  });

  describe('saveToCache + getCachedByRequest', () => {
    it('should cache X/Twitter requests', () => {
      const endpoint = '/v1/x/trending';
      const body = { query: 'test' };
      const response = { trends: ['ai'] };

      saveToCache(endpoint, body, response);
      const result = getCachedByRequest(endpoint, body);
      expect(result).toEqual(response);
    });

    it('should not cache chat requests', () => {
      const endpoint = '/v1/chat/completions';
      const body = { model: 'openai/gpt-5.4', messages: [] };

      saveToCache(endpoint, body, { choices: [] });
      const result = getCachedByRequest(endpoint, body);
      expect(result).toBeNull();
    });

    it('should not cache image requests', () => {
      const endpoint = '/v1/images/generations';
      saveToCache(endpoint, {}, { images: [] });
      expect(getCachedByRequest(endpoint, {})).toBeNull();
    });
  });

  describe('clearCache', () => {
    it('should remove cached entries', () => {
      setCache(TEST_KEY, { data: 'test' }, 60000);
      expect(getCached(TEST_KEY)).not.toBeNull();
      clearCache();
      expect(getCached(TEST_KEY)).toBeNull();
    });

    it('should return 0 when cache is empty', () => {
      clearCache();
      const count = clearCache();
      expect(count).toBe(0);
    });
  });
});
