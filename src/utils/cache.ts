import NodeCache from 'node-cache';
import fs from 'fs/promises';
import path from 'path';

/**
 * Global Cache Service handling both in-memory (L1) and file-system (L2) caching
 */
export class CacheService {
  private memoryCache: NodeCache;

  constructor() {
    // Standard TTL is 24 hours (86400 seconds)
    this.memoryCache = new NodeCache({ stdTTL: 86400, checkperiod: 120 });
  }

  /**
   * Generates a deterministic file path for the file system cache
   */
  private getFileSystemCachePath(accountId: string, key: string): string {
    const projectRoot = process.cwd(); // Assume we are running from root or properly scoped
    // Create a safe filename out of the key
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(projectRoot, '.cache', accountId.toLowerCase().replace(/_/g, '-'), `${safeKey}.json`);
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
      
      // If within 24 hours
      if (ageMs < 86400 * 1000) {
        const data = await fs.readFile(fsPath, 'utf-8');
        const parsed = JSON.parse(data) as T;
        
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
  async set<T>(accountId: string, key: string, data: T, ttlSeconds: number = 86400): Promise<void> {
    const memKey = `${accountId}::${key}`;
    
    // 1. Set L1
    this.memoryCache.set(memKey, data, ttlSeconds);

    // 2. Set L2
    const fsPath = this.getFileSystemCachePath(accountId, key);
    try {
      await fs.mkdir(path.dirname(fsPath), { recursive: true });
      await fs.writeFile(fsPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      const e = err as Error;
      console.error(`⚠️ Failed to write L2 cache for ${key}: ${e.message}`);
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
    } catch (err) {
      const e = err as Error;
      console.error(`⚠️ Failed to clear L2 cache for ${accountId}: ${e.message}`);
    }
  }
}

// Export a singleton instance
export const cacheService = new CacheService();
