import axios from 'axios';
import { cacheService } from '../utils/cache.js';
import { OAuthManager } from '../oauth/manager.js';
import { asyncJsonParse } from '../utils/json.js';

/**
 * Extracts table names from a SQL query string (used for cache invalidation).
 */
function extractTableNames(sqlQuery: string): string[] {
  const normalized = sqlQuery.toLowerCase();
  const tables = new Set<string>();
  const regex = /\b(?:from|join)\s+([a-zA-Z0-9_-]+)\b/g;
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    if (match[1]) tables.add(match[1]);
  }
  return Array.from(tables);
}

/**
 * NetSuite MCP Tools Client
 *
 * Communicates with NetSuite's MCP REST API using JSON-RPC 2.0.
 * Handles tool discovery, tool execution, caching, and 401 auto-retry.
 *
 * Design contract:
 * - Every public method has a single try/catch — no nested exception handling.
 * - 401 retry is inline (single retry after force-refreshing the token).
 * - All errors thrown are plain Error objects with descriptive messages.
 */
export class NetSuiteMCPTools {
  private readonly oauthManager: OAuthManager;
  customRecordMappings: Map<string, number> = new Map();
  hasFetchedMappings = false;

  constructor(oauthManager: OAuthManager) {
    this.oauthManager = oauthManager;

    // Load cached mappings from disk (fire-and-forget, no API call)
    this.loadCustomRecordMappingsCache().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to load custom record mappings cache: ${msg}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch available tools from NetSuite MCP API.
   * Uses cache with 1-hour TTL to avoid redundant network calls.
   */
  async fetchTools(): Promise<unknown[]> {
    const accountId = await this.oauthManager.getAccountId();

    // Check cache first
    if (accountId) {
      const cached = await cacheService.get<unknown[]>(accountId, 'toolsCache');
      if (cached) return cached;
    }

    const tools = await this.jsonRpcCall<{ tools: unknown[] }>('tools/list');

    if (!tools || !Array.isArray(tools.tools)) {
      throw new Error('Invalid tools/list response: missing result.tools array');
    }

    if (accountId) {
      await cacheService.set(accountId, 'toolsCache', tools.tools, 3600);
    }

    return tools.tools;
  }

  /**
   * Execute a NetSuite MCP tool by name.
   * Metadata results are cached. SuiteQL responses are slimmed.
   */
  async executeTool(toolName: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
    const accountId = await this.oauthManager.getAccountId();

    // --- Cache check for metadata tools ---
    if (this.isMetadataTool(toolName) && accountId) {
      const cacheKey = this.metadataCacheKey(toolName, parameters);
      try {
        const cached = await cacheService.get(accountId, cacheKey);
        if (cached) return cached;
      } catch {
        // Cache miss or read error — continue to API call
      }
    }

    console.error(`🔧 Executing tool: ${toolName}`);

    let result: unknown;
    try {
      result = await this.jsonRpcCall<unknown>('tools/call', {
        name: toolName,
        arguments: parameters
      });
    } catch (error: unknown) {
      // --- Self-healing: invalidate metadata cache for referenced tables on SuiteQL error ---
      if (toolName === 'ns_runCustomSuiteQL' && accountId) {
        const sqlQuery = (parameters.sqlQuery || parameters.query || '') as string;
        const tableNames = extractTableNames(sqlQuery);
        for (const table of tableNames) {
          try {
            await cacheService.delete(accountId, `ns_getSuiteQLMetadata_${table}`);
            await cacheService.delete(accountId, `ns_getRecordTypeMetadata_${table}`);
          } catch { /* cache cleanup is non-fatal */ }
        }
        if (tableNames.length > 0) {
          console.error(`🩹 [Self-heal] Invalidated metadata cache for: ${tableNames.join(', ')}`);
        }
      }
      throw error;
    }

    if (result === undefined) {
      throw new Error(`Tool '${toolName}' returned no result`);
    }

    console.error(`✅ Tool executed successfully`);

    // --- Slim SuiteQL response payload ---
    const finalResult = toolName === 'ns_runCustomSuiteQL'
      ? this.slimSuiteQLResponse(result)
      : result;

    // --- Cache metadata results ---
    if (this.isMetadataTool(toolName) && accountId) {
      const cacheKey = this.metadataCacheKey(toolName, parameters);
      try {
        await cacheService.set(accountId, cacheKey, finalResult);
      } catch {
        // Cache write failure is non-fatal
      }
    }

    return finalResult;
  }

  /**
   * Clear the tools cache (e.g. after re-authentication).
   */
  async clearCache(): Promise<void> {
    const accountId = await this.oauthManager.getAccountId();
    if (accountId) {
      await cacheService.set(accountId, 'toolsCache', null);
    }
  }

  /**
   * Force refresh NetSuite's internal REST session cache.
   */
  async refreshSessionCache(): Promise<void> {
    const accountId = await this.oauthManager.getAccountId();
    if (accountId) {
      await cacheService.clearAccountCache(accountId);
    }

    const accessToken = await this.oauthManager.ensureValidToken();
    const url = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/v1/session/cache/refresh`;

    try {
      await axios.post(url, {}, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      console.error('✅ NetSuite REST session cache refreshed');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to refresh NetSuite REST session cache: ${msg}`);
    }
  }

  /**
   * Clear all metadata cache for the current account.
   */
  async clearMetadataCache(): Promise<void> {
    try {
      const accountId = await this.oauthManager.getAccountId();
      if (accountId) {
        await cacheService.clearAccountCache(accountId);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to clear metadata cache: ${msg}`);
    }
  }

  /**
   * Fetch custom record type → internal ID mappings from NetSuite.
   * Called after successful authentication, NOT in the constructor.
   */
  async fetchCustomRecordMappings(): Promise<void> {
    if (this.hasFetchedMappings) return;
    this.hasFetchedMappings = true;

    try {
      console.error('🔍 Fetching custom record mappings from NetSuite...');
      const rawResult = await this.executeTool('ns_runCustomSuiteQL', {
        sqlQuery: 'SELECT internalId, scriptId FROM customrecordtype'
      });

      const records = this.extractDataArray(rawResult);
      if (records.length === 0) return;

      const newMappings: Record<string, number> = {};
      for (const record of records) {
        const scriptId = (String(record.scriptid || record.scriptId || '')).toUpperCase().trim();
        const internalId = parseInt(String(record.internalid || record.internalId), 10);
        if (scriptId && !isNaN(internalId)) {
          this.customRecordMappings.set(scriptId, internalId);
          newMappings[scriptId] = internalId;
        }
      }

      const accountId = await this.oauthManager.getAccountId();
      if (accountId) {
        await cacheService.set(accountId, 'customrecord_mappings', newMappings);
        console.error(`✅ Saved ${this.customRecordMappings.size} custom record mappings`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to fetch custom record mappings: ${msg}`);
    }
  }

  /**
   * Prefetch metadata for commonly used record types in parallel.
   */
  async prefetchCommonMetadata(): Promise<void> {
    const types = ['customer', 'salesorder', 'item', 'transaction'];
    console.error(`🚀 Prefetching metadata for: ${types.join(', ')}...`);

    await Promise.all(
      types.map(async (recordType) => {
        try {
          await this.executeTool('ns_getRecordTypeMetadata', { recordType });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`⚠️ Failed to prefetch metadata for ${recordType}: ${msg}`);
        }
      })
    );

    console.error('✅ Prefetching common metadata completed.');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Core JSON-RPC 2.0 call to NetSuite MCP API.
   * Includes single 401 auto-retry after force-refreshing the token.
   */
  private async jsonRpcCall<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    let accessToken = await this.oauthManager.ensureValidToken();
    const endpoint = await this.getEndpoint();

    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: `mcp-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      method
    };
    if (params) body.params = params;

    const makeRequest = async (token: string): Promise<T> => {
      const response = await axios.post(endpoint, body, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        timeout: method === 'tools/list' ? 30000 : 60000
      });

      if (response.data?.error) {
        throw new Error(response.data.error.message || `JSON-RPC error in ${method}`);
      }

      return response.data?.result as T;
    };

    try {
      return await makeRequest(accessToken);
    } catch (error: unknown) {
      const axiosErr = error as { response?: { status?: number }; code?: string };

      // --- 401 retry: force-refresh token and try once more ---
      if (axiosErr.response?.status === 401) {
        console.error('🔄 [401 Retry] Force-refreshing token and retrying...');
        accessToken = await this.oauthManager.forceRefreshToken(accessToken);
        return await makeRequest(accessToken);
      }

      // --- Transient error retry: network issues and rate limits ---
      const transientCodes = new Set(['ECONNABORTED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE']);
      const retryableStatuses = new Set([429, 503]);
      const isTransient = transientCodes.has(axiosErr.code || '')
        || retryableStatuses.has(axiosErr.response?.status || 0);

      if (isTransient) {
        const reason = axiosErr.code || `HTTP ${axiosErr.response?.status}`;
        console.error(`🔄 [Transient Retry] ${reason} — waiting 2s then retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        return await makeRequest(accessToken);
      }

      throw error;
    }
  }

  /** Build the NetSuite MCP API endpoint URL. */
  private async getEndpoint(): Promise<string> {
    const accountId = await this.oauthManager.getAccountId();
    if (!accountId) {
      throw new Error('Account ID not found. Please authenticate first.');
    }
    return `https://${accountId}.suitetalk.api.netsuite.com/services/mcp/v1/all`;
  }

  /** Check if a tool name is a metadata tool that should be cached. */
  private isMetadataTool(toolName: string): boolean {
    return toolName === 'ns_getSuiteQLMetadata' || toolName === 'ns_getRecordTypeMetadata';
  }

  /** Generate a cache key for metadata tools. */
  private metadataCacheKey(toolName: string, params: Record<string, unknown>): string {
    const recordType = (params.recordType as string) || (params.tableName as string) || 'all';
    return `${toolName}_${recordType}`;
  }

  /**
   * Slim a SuiteQL response to only include essential data fields.
   */
  private slimSuiteQLResponse(result: unknown): unknown {
    if (!result || typeof result !== 'object') return result;

    const resObj = result as Record<string, unknown>;
    let suiteqlData: Record<string, unknown> | null = null;

    // Direct shape: { method: 'custom_suiteql', data: [...] }
    if (resObj.method === 'custom_suiteql' && Array.isArray(resObj.data)) {
      suiteqlData = resObj;
    }
    // Wrapped shape: { content: [{ text: '...' }] }
    else if (Array.isArray(resObj.content)) {
      const firstContent = (resObj.content as Array<{ text?: string }>)[0];
      if (firstContent?.text && typeof firstContent.text === 'string') {
        try {
          const parsed = JSON.parse(firstContent.text) as Record<string, unknown>;
          if (parsed.method === 'custom_suiteql' && Array.isArray(parsed.data)) {
            suiteqlData = parsed;
          }
        } catch {
          // Not JSON — return as-is
        }
      }
    }

    if (suiteqlData) {
      return {
        totalResults: suiteqlData.totalResults,
        numberOfPages: suiteqlData.numberOfPages,
        data: suiteqlData.data
      };
    }

    return result;
  }

  /** Load custom record mappings from local file cache (no API call). */
  private async loadCustomRecordMappingsCache(): Promise<void> {
    const accountId = await this.oauthManager.getAccountId();
    if (!accountId) return;

    const mappingsObj = await cacheService.get<Record<string, number>>(accountId, 'customrecord_mappings');
    if (mappingsObj) {
      this.customRecordMappings = new Map(Object.entries(mappingsObj));
      console.error(`⚡ Loaded ${this.customRecordMappings.size} custom record mappings from cache`);
    }
  }

  /**
   * Extract a data array from various NetSuite response shapes.
   */
  private extractDataArray(result: unknown): Array<Record<string, unknown>> {
    if (!result || typeof result !== 'object') return [];

    let data = result as Record<string, unknown>;

    // Unwrap content wrapper
    if (Array.isArray(data.content)) {
      const content = (data.content as Array<{ text?: string }>)[0];
      if (content?.text && typeof content.text === 'string') {
        try {
          data = JSON.parse(content.text) as Record<string, unknown>;
        } catch {
          return [];
        }
      }
    }

    // Unwrap string result
    if (typeof result === 'string') {
      try {
        data = JSON.parse(result) as Record<string, unknown>;
      } catch {
        return [];
      }
    }

    const records = (data.data || data.records || []) as Array<Record<string, unknown>>;
    return Array.isArray(records) ? records : [];
  }
}
