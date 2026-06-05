import NodeCache from 'node-cache';
import fs from 'fs/promises';
import path from 'path';
import { asyncJsonParse } from './json.js';

/**
 * Global Cache Service handling both in-memory (L1) and file-system (L2) caching.
 * Call `configure(projectRoot)` at startup to set the base directory for L2 file cache.
 */
export class CacheService {
  private memoryCache: NodeCache;
  private projectRoot: string;

  constructor(projectRoot?: string) {
    // Standard TTL is 1 hour (3600 seconds)
    this.memoryCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
    this.projectRoot = projectRoot ?? process.cwd();
  }

  /**
   * Set the project root directory for file-system cache.
   * Should be called once at startup before any cache operations.
   */
  configure(projectRoot: string): void {
    this.projectRoot = projectRoot;
  }

  /**
   * Generates a deterministic file path for the file system cache
   */
  private getFileSystemCachePath(accountId: string, key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.projectRoot, '.cache', accountId.toLowerCase().replace(/_/g, '-'), `${safeKey}.json`);
  }

  /**
   * Retrieves data from Cache (Checks L1 memory first, then L2 file system)
   */
  async get<T>(accountId: string, key: string): Promise<T | null> {
    const memKey = `${accountId}::${key}`;
    
    // 1. Check L1 Memory Cache
    const memResult = this.memoryCache.get<T>(memKey);
    if (memResult !== undefined) {
      console.error(`⚡ [Cache Hit L1] Memory cache hit for ${key}`);
      return memResult;
    }

    // 2. Check L2 File System Cache
    const fsPath = this.getFileSystemCachePath(accountId, key);
    try {
      const stats = await fs.stat(fsPath);
      const ageMs = Date.now() - stats.mtimeMs;
      
      // If within 1 hour
      if (ageMs < 3600 * 1000) {
        const data = await fs.readFile(fsPath, 'utf-8');
        const parsed = await asyncJsonParse<T>(data);
        
        // Promote back to L1
        this.memoryCache.set(memKey, parsed);
        console.error(`⚡ [Cache Hit L2] File cache hit for ${key}. Promoted to L1.`);
        
        return parsed;
      }
    } catch {
      // Doesn't exist or error
    }

    return null;
  }

  /**
   * Saves data to both L1 and L2 caches
   */
  async set<T>(accountId: string, key: string, data: T, ttlSeconds: number = 3600): Promise<void> {
    const memKey = `${accountId}::${key}`;
    
    // 1. Set L1
    this.memoryCache.set(memKey, data, ttlSeconds);

    // 2. Set L2
    const fsPath = this.getFileSystemCachePath(accountId, key);
    try {
      await fs.mkdir(path.dirname(fsPath), { recursive: true });
      await fs.writeFile(fsPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to write L2 cache for ${key}: ${message}`);
    }
  }

  /**
   * Deletes a specific cache key from both L1 and L2 caches
   */
  async delete(accountId: string, key: string): Promise<void> {
    const memKey = `${accountId}::${key}`;
    this.memoryCache.del(memKey);

    const fsPath = this.getFileSystemCachePath(accountId, key);
    try {
      await fs.unlink(fsPath);
      console.error(`🗑️ Cache key deleted: ${key}`);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  /**
   * Clears all cache for a specific account ID
   */
  async clearAccountCache(accountId: string): Promise<void> {
    // Clear L1
    const keys = this.memoryCache.keys();
    const accountKeys = keys.filter(k => k.startsWith(`${accountId}::`));
    this.memoryCache.del(accountKeys);

    // Clear L2
    const fsDir = path.dirname(this.getFileSystemCachePath(accountId, 'dummy'));
    try {
      await fs.rm(fsDir, { recursive: true, force: true });
      console.error(`🗑️ L1 and L2 Cache cleared for account ${accountId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to clear L2 cache for ${accountId}: ${message}`);
    }
  }
}

// Export a singleton instance
export const cacheService = new CacheService();
