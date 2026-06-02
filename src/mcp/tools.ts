import axios from 'axios';
import { cacheService } from '../utils/cache.js';

/**
 * NetSuite MCP Tools Client
 * Communicates with NetSuite MCP REST API using JSON-RPC 2.0
 */
export class NetSuiteMCPTools {
  oauthManager: any;
  toolsCache: any = null;
  lastToolsFetch: number | null = null;
  toolsCacheTTL: number = 1000;
  customRecordMappings: Map<string, number>;
  hasFetchedMappings: boolean = false;

  constructor(oauthManager: any) {
    this.oauthManager = oauthManager;
    this.customRecordMappings = new Map();
    // Load custom record mappings from local cache in background
    this.loadCustomRecordMappingsCache();
    this.fetchCustomRecordMappings().catch(() => {});
  }

  /**
   * Get NetSuite MCP API endpoint URL
   */
  async getMCPEndpoint() {
    const accountId = await this.oauthManager.getAccountId();
    if (!accountId) {
      throw new Error('Account ID not found. Please authenticate first.');
    }
    return `https://${accountId}.suitetalk.api.netsuite.com/services/mcp/v1/all`;
  }

  /**
   * Fetch available tools from NetSuite
   */
  async fetchTools() {
    try {
      const accountId = await this.oauthManager.getAccountId();
      if (accountId) {
        const cachedTools = await cacheService.get(accountId, 'toolsCache');
        if (cachedTools) {
          return cachedTools;
        }
      }

      const accessToken = await this.oauthManager.ensureValidToken();
      const endpoint = await this.getMCPEndpoint();

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
        timeout: 30000 // 30 second timeout for tool listing
      });

      if (response.data.error) {
        throw new Error(response.data.error.message || 'Failed to fetch tools');
      }

      const tools = response.data.result.tools || [];
      if (accountId) {
        await cacheService.set(accountId, 'toolsCache', tools, 3600); // 1 hour TTL
      }
      return tools;
    } catch (error: any) {
      console.error(`❌ Failed to fetch tools from NetSuite: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute a NetSuite MCP tool
   * @param {string} toolName - Name of the tool to execute
   * @param {object} parameters - Tool parameters
   * @returns {object} Tool execution result
   */
  async executeTool(toolName, parameters) {
    // Intercept metadata tools for schema caching
    if (toolName === 'ns_getSuiteQLMetadata' || toolName === 'ns_getRecordTypeMetadata') {
      try {
        const accountId = await this.oauthManager.getAccountId();
        if (accountId) {
          const cacheKey = `${toolName}_${parameters?.recordType || 'all'}`;
          const cachedResult = await cacheService.get(accountId, cacheKey);
          if (cachedResult) {
            return cachedResult;
          }
        }
      } catch (err: any) {
        console.error(`⚠️ Failed to read metadata cache: ${err.message}`);
      }
    }

    const accessToken = await this.oauthManager.ensureValidToken();
    const endpoint = await this.getMCPEndpoint();

    console.error(`🔧 Executing tool: ${toolName}`);

    try {
      const response = await axios.post(endpoint, {
        jsonrpc: '2.0',
        id: this.generateRequestId(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: parameters || {}
        }
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        },
        timeout: 60000 // 60 second timeout for tool execution
      });

      if (response.data.error) {
        const errorMsg = response.data.error.message || 'Tool execution failed';
        console.error(`❌ Tool execution error: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      console.error(`✅ Tool executed successfully`);
      const result = response.data.result;

      // Save to cache after successful execution
      if (toolName === 'ns_getSuiteQLMetadata' || toolName === 'ns_getRecordTypeMetadata') {
        try {
          const accountId = await this.oauthManager.getAccountId();
          if (accountId) {
            const cacheKey = `${toolName}_${parameters?.recordType || 'all'}`;
            await cacheService.set(accountId, cacheKey, result);
          }
        } catch (err: any) {
          console.error(`⚠️ Failed to write metadata cache: ${err.message}`);
        }
      }

      return result;

    } catch (error) {
      if (error.response?.status === 401) {
        console.error('❌ Authentication failed during tool execution');
        throw new Error('NetSuite authentication failed. Please re-authenticate.');
      }

      // Self-Healing Cache Invalidation: clear local cache on any SuiteQL execution error
      if (toolName === 'ns_runCustomSuiteQL') {
        console.error('⚠️ SuiteQL error encountered. Automatically clearing metadata cache to ensure fresh schema...');
        try {
          await this.clearMetadataCache();
        } catch (err) {
          console.error(`⚠️ Failed to self-heal/clear metadata cache: ${err.message}`);
        }
      }

      console.error('❌ Tool execution error:', error.response?.data || error.message);
      throw new Error(`Tool execution failed: ${error.message}`);
    }
  }

  /**
   * Get tool by name from cache
   */
  async getTool(toolName) {
    if (!this.toolsCache) {
      await this.fetchTools();
    }

    return this.toolsCache?.find(tool => tool.name === toolName);
  }

  /**
   * Validate tool parameters against tool schema
   */
  validateParameters(tool, parameters) {
    if (!tool || !tool.inputSchema) {
      return true; // No schema to validate against
    }

    const schema = tool.inputSchema;
    const required = schema.required || [];

    // Check required parameters
    for (const param of required) {
      if (!(param in parameters)) {
        throw new Error(`Missing required parameter: ${param}`);
      }
    }

    return true;
  }

  /**
   * Generate unique request ID for JSON-RPC
   */
  generateRequestId() {
    return `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clear tools cache (useful after re-authentication)
   */
  async clearCache() {
    const accountId = await this.oauthManager.getAccountId();
    if (accountId) {
      await cacheService.set(accountId, 'toolsCache', null);
    }
    this.toolsCache = null;
    this.lastToolsFetch = null;
    console.error('🗑️  Tools cache cleared');
  }

  /**
   * Get cache status
   */
  getCacheStatus() {
    if (!this.toolsCache) {
      return { cached: false };
    }

    const age = Date.now() - this.lastToolsFetch;
    return {
      cached: true,
      toolCount: this.toolsCache.length,
      ageSeconds: Math.round(age / 1000),
      expiresIn: Math.round((this.toolsCacheTTL - age) / 1000)
    };
  }

  /**
   * Force refresh NetSuite REST session filter set cache
   */
  async refreshSessionCache() {
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
    } catch (error) {
      console.error('❌ Cache refresh failed:', error.response?.data || error.message);
      throw new Error(`Failed to refresh NetSuite REST session cache: ${error.message}`);
    }
  }

  /**
   * Clear metadata cache for current account
   */
  async clearMetadataCache() {
    try {
      const accountId = await this.oauthManager.getAccountId();
      if (!accountId) return;
      await cacheService.clearAccountCache(accountId);
    } catch (err: any) {
      console.error(`⚠️ Failed to clear metadata cache: ${err.message}`);
    }
  }

  /**
   * Load custom record mappings from local cache file
   */
  async loadCustomRecordMappingsCache() {
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
   * Fetch custom record type ID mapping from NetSuite
   */
  async fetchCustomRecordMappings() {
    if (this.hasFetchedMappings) return;
    this.hasFetchedMappings = true;

    try {
      console.error('🔍 Fetching dynamic custom record mappings from NetSuite...');
      
      // Query customrecordtype table
      const sqlQuery = 'SELECT internalId, scriptId FROM customrecordtype';
      const result = await this.executeTool('ns_runCustomSuiteQL', { sqlQuery });
      
      let data = result;
      if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
        data = JSON.parse(result.content[0].text);
      } else if (typeof result === 'string') {
        data = JSON.parse(result);
      }
      
      const records = data.data || data.records || [];
      if (records.length > 0) {
        const newMappings = {};
        for (const record of records) {
          const scriptId = (record.scriptid || record.scriptId || '').toUpperCase().trim();
          const internalId = parseInt(record.internalid || record.internalId, 10);
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
    } catch (err) {
      console.error(`⚠️ Failed to fetch custom record mappings: ${err.message}`);
    }
  }
}
