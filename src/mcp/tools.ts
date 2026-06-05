import axios from 'axios';
import crypto from 'crypto';
import { cacheService } from '../utils/cache.js';
import { OAuthManager } from '../oauth/manager.js';
import { asyncJsonParse } from '../utils/json.js';

function isStaticTableQuery(sqlQuery: string): boolean {
  const normalized = sqlQuery.toLowerCase();
  const staticTables = ['subsidiary', 'currency', 'location', 'department', 'classification'];
  
  const hasFromStaticTable = staticTables.some(table => {
    const regex = new RegExp(`\\bfrom\\s+${table}\\b|\\bjoin\\s+${table}\\b`);
    return regex.test(normalized);
  });
  
  if (!hasFromStaticTable) return false;
  
  const dynamicTables = ['transaction', 'customer', 'item', 'employee', 'journalentry', 'salesorder', 'invoice', 'opportunity', 'contact', 'vendor'];
  const hasDynamicTable = dynamicTables.some(table => {
    const regex = new RegExp(`\\bfrom\\s+${table}\\b|\\bjoin\\s+${table}\\b`);
    return regex.test(normalized);
  });
  
  return !hasDynamicTable;
}

function extractTableNames(sqlQuery: string): string[] {
  const normalized = sqlQuery.toLowerCase();
  const tables = new Set<string>();
  
  // Regular expressions to match table names after FROM or JOIN
  const regex = /\b(?:from|join)\s+([a-zA-Z0-9_-]+)\b/g;
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    if (match[1]) {
      tables.add(match[1]);
    }
  }
  return Array.from(tables);
}

/**
 * NetSuite MCP Tools Client
 * Communicates with NetSuite MCP REST API using JSON-RPC 2.0
 */
export class NetSuiteMCPTools {
  private oauthManager: OAuthManager;
  customRecordMappings: Map<string, number>;
  hasFetchedMappings: boolean = false;

  constructor(oauthManager: OAuthManager) {
    this.oauthManager = oauthManager;
    this.customRecordMappings = new Map();
    // Load custom record mappings from local cache in background (safe fire-and-forget, no API call)
    this.loadCustomRecordMappingsCache().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to load custom record mappings cache: ${message}`);
    });
    // NOTE: fetchCustomRecordMappings() is deliberately NOT called here.
    // It requires authentication and is called after successful auth in index.ts.
  }

  /**
   * Get NetSuite MCP API endpoint URL
   */
  async getMCPEndpoint(): Promise<string> {
    const accountId = await this.oauthManager.getAccountId();
    if (!accountId) {
      throw new Error('Account ID not found. Please authenticate first.');
    }
    return `https://${accountId}.suitetalk.api.netsuite.com/services/mcp/v1/all`;
  }

  /**
   * Fetch available tools from NetSuite
   */
  async fetchTools(): Promise<unknown[]> {
    try {
      const accountId = await this.oauthManager.getAccountId();
      if (accountId) {
        const cachedTools = await cacheService.get<unknown[]>(accountId, 'toolsCache');
        if (cachedTools) {
          return cachedTools;
        }
      }

      // Try fetching tools with automatic 401 retry
      const tools = await this._fetchToolsWithRetry();

      if (accountId) {
        await cacheService.set(accountId, 'toolsCache', tools, 3600); // 1 hour TTL
      }
      return tools;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to fetch tools from NetSuite: ${message}`);
      throw error;
    }
  }

  /**
   * Internal: fetch tools from NetSuite with 401 auto-retry
   */
  private async _fetchToolsWithRetry(): Promise<unknown[]> {
    let accessToken = await this.oauthManager.ensureValidToken();
    const endpoint = await this.getMCPEndpoint();

    const doFetch = async (): Promise<unknown[]> => {
      const response = await axios.post(endpoint, {
        jsonrpc: '2.0',
        id: this.generateRequestId(),
        method: 'tools/list'
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        },
        timeout: 30000
      });

      if (response.data.error) {
        throw new Error(response.data.error.message || 'Failed to fetch tools');
      }

      const result = response.data?.result;
      if (!result || !Array.isArray(result.tools)) {
        throw new Error('Invalid tools/list response: missing result.tools array');
      }

      return result.tools;
    };

    try {
      return await doFetch();
    } catch (error: unknown) {
      const err = error as { response?: { status?: number } };
      // On 401, force-refresh token and retry once
      if (err.response?.status === 401) {
        console.error('🔄 [401 Retry] Token expired during fetchTools, force-refreshing and retrying...');
        accessToken = await this.oauthManager.forceRefreshToken();
        return await doFetch();
      }
      throw error;
    }
  }

  /**
   * Execute a NetSuite MCP tool
   */
  async executeTool(toolName: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
    const accountId = await this.oauthManager.getAccountId();


    // Intercept metadata tools for schema caching
    if (toolName === 'ns_getSuiteQLMetadata' || toolName === 'ns_getRecordTypeMetadata') {
      try {
        if (accountId) {
          const recordType = (parameters?.recordType as string) || 'all';
          const cacheKey = `${toolName}_${recordType}`;
          const cachedResult = await cacheService.get(accountId, cacheKey);
          if (cachedResult) {
            return cachedResult;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`⚠️ Failed to read metadata cache: ${message}`);
      }
    }



    let accessToken = await this.oauthManager.ensureValidToken();
    const endpoint = await this.getMCPEndpoint();

    console.error(`🔧 Executing tool: ${toolName}`);

    const doExecute = async (): Promise<unknown> => {
      const response = await axios.post(endpoint, {
        jsonrpc: '2.0',
        id: this.generateRequestId(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: parameters
        }
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        timeout: 60000 // 60 second timeout for tool execution
      });

      if (response.data.error) {
        const errorMsg = response.data.error.message || 'Tool execution failed';
        console.error(`❌ Tool execution error: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const result = response.data?.result;
      if (result === undefined) {
        throw new Error(`Tool '${toolName}' returned no result`);
      }

      // Perform response payload slimming for SuiteQL results
      if (toolName === 'ns_runCustomSuiteQL' && result && typeof result === 'object') {
        const resObj = result as Record<string, unknown>;
        let suiteqlData: Record<string, unknown> | null = null;

        if (resObj.method === 'custom_suiteql' && Array.isArray(resObj.data)) {
          suiteqlData = resObj;
        } else if (Array.isArray(resObj.content) && resObj.content[0] && typeof resObj.content[0].text === 'string') {
          try {
            const parsedText = JSON.parse(resObj.content[0].text);
            if (parsedText && typeof parsedText === 'object' && parsedText.method === 'custom_suiteql' && Array.isArray(parsedText.data)) {
              suiteqlData = parsedText;
            }
          } catch {
            // Ignore parse errors
          }
        }

        if (suiteqlData) {
          return {
            totalResults: suiteqlData.totalResults,
            numberOfPages: suiteqlData.numberOfPages,
            data: suiteqlData.data
          };
        }
      }

      return result;
    };

    try {
      let result: unknown;
      try {
        result = await doExecute();
      } catch (error: unknown) {
        const err = error as { response?: { status?: number } };
        // On 401, force-refresh token and retry once
        if (err.response?.status === 401) {
          console.error('🔄 [401 Retry] Token expired during executeTool, force-refreshing and retrying...');
          accessToken = await this.oauthManager.forceRefreshToken();
          result = await doExecute();
        } else {
          throw error;
        }
      }

      console.error(`✅ Tool executed successfully`);

      // Save to cache after successful execution
      if (accountId) {
        if (toolName === 'ns_getSuiteQLMetadata' || toolName === 'ns_getRecordTypeMetadata') {
          try {
            const recordType = (parameters?.recordType as string) || 'all';
            const cacheKey = `${toolName}_${recordType}`;
            await cacheService.set(accountId, cacheKey, result);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`⚠️ Failed to write metadata cache: ${message}`);
          }
        }
      }

      return result;

    } catch (error: unknown) {
      // Self-Healing Cache Invalidation: clear local cache on any SuiteQL execution error
      if (toolName === 'ns_runCustomSuiteQL') {
        const sqlQuery = parameters.sqlQuery as string;
        if (sqlQuery && accountId) {
          const tableNames = extractTableNames(sqlQuery);
          if (tableNames.length > 0) {
            console.error(`⚠️ SuiteQL error on tables [${tableNames.join(', ')}]. Performing selective cache invalidation...`);
            for (const tableName of tableNames) {
              try {
                await cacheService.delete(accountId, `ns_getSuiteQLMetadata_${tableName}`);
                await cacheService.delete(accountId, `ns_getRecordTypeMetadata_${tableName}`);
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`⚠️ Failed to delete selective cache for ${tableName}: ${message}`);
              }
            }
          } else {
            console.error('⚠️ SuiteQL error encountered. No table names parsed. Automatically clearing entire metadata cache...');
            try {
              await this.clearMetadataCache();
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              console.error(`⚠️ Failed to self-heal/clear metadata cache: ${message}`);
            }
          }
        }
      }

      const err = error as { response?: { data?: unknown }; message?: string };
      console.error('❌ Tool execution error:', err.response?.data || err.message);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Tool execution failed: ${message}`);
    }
  }

  /**
   * Generate unique request ID for JSON-RPC
   */
  private generateRequestId(): string {
    return `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clear tools cache (useful after re-authentication)
   */
  async clearCache(): Promise<void> {
    const accountId = await this.oauthManager.getAccountId();
    if (accountId) {
      await cacheService.set(accountId, 'toolsCache', null);
    }
    console.error('🗑️  Tools cache cleared');
  }

  /**
   * Force refresh NetSuite REST session filter set cache
   */
  async refreshSessionCache(): Promise<boolean> {
    const accountId = await this.oauthManager.getAccountId();
    if (accountId) {
      await cacheService.clearAccountCache(accountId);
    }
    const accessToken = await this.oauthManager.ensureValidToken();
    const refreshUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/v1/session/cache/refresh`;

    console.error('🔄 Refreshing NetSuite REST session cache...');

    try {
      await axios.post(refreshUrl, {}, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        },
        timeout: 10000
      });
      console.error('✅ NetSuite REST session cache refreshed successfully');
      return true;
    } catch (error: unknown) {
      const err = error as { response?: { data?: unknown }; message?: string };
      console.error('❌ Cache refresh failed:', err.response?.data || err.message);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to refresh NetSuite REST session cache: ${message}`);
    }
  }

  /**
   * Clear metadata cache for current account
   */
  async clearMetadataCache(): Promise<void> {
    try {
      const accountId = await this.oauthManager.getAccountId();
      if (!accountId) return;
      await cacheService.clearAccountCache(accountId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to clear metadata cache: ${message}`);
    }
  }

  /**
   * Load custom record mappings from local cache file
   */
  private async loadCustomRecordMappingsCache(): Promise<void> {
    try {
      const accountId = await this.oauthManager.getAccountId();
      if (!accountId) return;

      const mappingsObj = await cacheService.get<Record<string, number>>(accountId, 'customrecord_mappings');
      if (mappingsObj) {
        this.customRecordMappings = new Map(Object.entries(mappingsObj));
        console.error(`⚡ Loaded ${this.customRecordMappings.size} custom record mappings from local cache`);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Fetch custom record type ID mapping from NetSuite.
   * Should be called after successful authentication, NOT in constructor.
   */
  async fetchCustomRecordMappings(): Promise<void> {
    if (this.hasFetchedMappings) return;
    this.hasFetchedMappings = true;

    try {
      console.error('🔍 Fetching dynamic custom record mappings from NetSuite...');
      
      // Query customrecordtype table
      const sqlQuery = 'SELECT internalId, scriptId FROM customrecordtype';
      const result = await this.executeTool('ns_runCustomSuiteQL', { sqlQuery }) as Record<string, unknown>;
      
      let data: Record<string, unknown> = result;
      if (result && Array.isArray((result as Record<string, unknown>).content)) {
        const content = (result as { content: Array<{ text?: string }> }).content;
        if (content[0] && typeof content[0].text === 'string') {
          data = await asyncJsonParse<Record<string, unknown>>(content[0].text);
        }
      } else if (typeof result === 'string') {
        data = await asyncJsonParse<Record<string, unknown>>(result);
      }
      
      const records = (data.data || data.records || []) as Array<Record<string, unknown>>;
      if (records.length > 0) {
        const newMappings: Record<string, number> = {};
        for (const record of records) {
          const scriptId = ((record.scriptid || record.scriptId || '') as string).toUpperCase().trim();
          const internalId = parseInt(String(record.internalid || record.internalId), 10);
          if (scriptId && !isNaN(internalId)) {
            this.customRecordMappings.set(scriptId, internalId);
            newMappings[scriptId] = internalId;
          }
        }
        
        // Save to cache
        const accountId = await this.oauthManager.getAccountId();
        if (accountId) {
          await cacheService.set(accountId, 'customrecord_mappings', newMappings);
          console.error(`✅ Saved ${this.customRecordMappings.size} custom record mappings to cache`);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to fetch custom record mappings: ${message}`);
    }
  }

  /**
   * Prefetch metadata for commonly used record types in parallel
   */
  async prefetchCommonMetadata(): Promise<void> {
    const commonTypes = ['customer', 'salesorder', 'item', 'transaction'];
    console.error(`🚀 Prefetching metadata for common records in parallel: ${commonTypes.join(', ')}...`);
    try {
      await Promise.all(
        commonTypes.map(async (recordType) => {
          try {
            await this.executeTool('ns_getRecordTypeMetadata', { recordType });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`⚠️ Failed to prefetch metadata for ${recordType}: ${message}`);
          }
        })
      );
      console.error('✅ Prefetching common metadata completed.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Prefetch error: ${message}`);
    }
  }
}
