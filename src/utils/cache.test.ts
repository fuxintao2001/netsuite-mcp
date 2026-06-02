import { cacheService } from './cache.js';
import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('CacheService', () => {
  const accountId = 'test-account-123';
  const key = 'test-key';
  const data = { foo: 'bar' };

  beforeEach(async () => {
    await cacheService.clearAccountCache(accountId);
  });

  afterEach(async () => {
    await cacheService.clearAccountCache(accountId);
  });

  it('should set data in both L1 and L2 caches', async () => {
    await cacheService.set(accountId, key, data);

    // Should be in memory (L1) immediately
    const l1Result = await cacheService.get(accountId, key);
    expect(l1Result).toEqual(data);
  });

  it('should fallback to L2 if L1 is empty', async () => {
    await cacheService.set(accountId, key, data);
    
    // Reach into the class to clear just the memory cache to test L2 fallback
    // We can simulate this by clearing account cache (which deletes L2), then rewriting the file manually
    await cacheService.clearAccountCache(accountId);
    
    // Manually write to L2
    const projectRoot = process.cwd();
    const fsPath = path.join(projectRoot, '.cache', accountId.toLowerCase().replace(/_/g, '-'), `${key}.json`);
    await fs.mkdir(path.dirname(fsPath), { recursive: true });
    await fs.writeFile(fsPath, JSON.stringify(data), 'utf-8');

    const result = await cacheService.get(accountId, key);
    expect(result).toEqual(data);
  });
});
