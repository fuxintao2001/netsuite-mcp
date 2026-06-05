#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OAuthManager } from './oauth/manager.js';
import { NetSuiteMCPTools } from './mcp/tools.js';
import { cacheService } from './utils/cache.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';
import https from 'https';
import axios from 'axios';

// Configure Axios global agents for HTTP Keep-Alive connection pooling
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });

// Import Handlers
import { registerResourceHandlers } from './handlers/resources.js';
import { registerToolHandlers } from './handlers/tools.js';
import type { ToolHandlerDeps } from './handlers/tools.js';
import { validateEnv } from './utils/envValidator.js';

/** Helper to create a text content response matching MCP SDK's CallToolResult shape */
function textResult(text: string, isError?: boolean): CallToolResult {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname); // Go up one level from dist/ or src/ to project root

class NetSuiteMCPServer {
  private oauthManager: OAuthManager;
  private mcpTools: NetSuiteMCPTools;
  private isAuthenticated: boolean;
  private server: Server;

  constructor() {
    // --- Validate environment at startup with Zod ---
    const envConfig = validateEnv();
    const callbackPort = envConfig.OAUTH_CALLBACK_PORT;

    if (!envConfig.NETSUITE_ACCOUNT_ID) {
      console.error('⚠️  NETSUITE_ACCOUNT_ID not set. User must provide accountId during authentication.');
    }
    if (!envConfig.NETSUITE_CLIENT_ID) {
      console.error('⚠️  NETSUITE_CLIENT_ID not set. User must provide clientId during authentication.');
    }

    // Configure cache with project root instead of relying on process.cwd()
    cacheService.configure(projectRoot);

    const sessionsPath = envConfig.NETSUITE_SESSION_PATH || (envConfig.NETSUITE_ACCOUNT_ID 
      ? join(projectRoot, 'sessions', envConfig.NETSUITE_ACCOUNT_ID.toLowerCase()) 
      : join(projectRoot, 'sessions'));

    this.oauthManager = new OAuthManager({
      storagePath: sessionsPath,
      callbackPort
    });

    this.mcpTools = new NetSuiteMCPTools(this.oauthManager);
    this.isAuthenticated = false;

    this.server = new Server({
      name: 'netsuite-mcp',
      version: '1.0.0',
    }, {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      }
    });
  }

  setupHandlers(): void {
    registerResourceHandlers(this.server, projectRoot);

    const deps: ToolHandlerDeps = {
      server: this.server,
      oauthManager: this.oauthManager,
      mcpTools: this.mcpTools,
      projectRoot,
      handleAuthentication: this.handleAuthentication.bind(this),
      handleLogout: this.handleLogout.bind(this),
      handleCacheRefresh: this.handleCacheRefresh.bind(this),
      resolveCustomRecordRectype: this.resolveCustomRecordRectype.bind(this)
    };

    registerToolHandlers(deps);
  }

  private async handleAuthentication(args: Record<string, unknown>) {
    const accountId = (args.accountId as string) || process.env.NETSUITE_ACCOUNT_ID;
    const clientId = (args.clientId as string) || process.env.NETSUITE_CLIENT_ID;

    if (!accountId || !clientId) {
      return textResult('❌ Missing required credentials. Provide accountId and clientId, or set NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables.', true);
    }

    try {
      console.error('\n🔐 Starting NetSuite authentication...');
      await this.oauthManager.startAuthFlow({ accountId, clientId });
      this.isAuthenticated = true;
      await this.mcpTools.clearCache();

      // Start proactive token refresh after successful authentication
      this.oauthManager.startProactiveRefresh();

      // Fetch custom record mappings and prefetch common metadata in parallel in background
      this.mcpTools.fetchCustomRecordMappings()
        .then(() => this.mcpTools.prefetchCommonMetadata())
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`⚠️ Background prefetch failed: ${message}`);
        });

      return textResult('✅ Successfully authenticated with NetSuite!');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`❌ Authentication failed: ${message}`, true);
    }
  }

  private async handleLogout() {
    try {
      await this.oauthManager.clearSession();
      await this.mcpTools.clearCache();
      this.isAuthenticated = false;
      return textResult('✅ Successfully logged out from NetSuite!');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`❌ Logout failed: ${message}`, true);
    }
  }

  private async handleCacheRefresh() {
    try {
      await this.mcpTools.refreshSessionCache();
      await this.mcpTools.clearMetadataCache();
      return textResult('✅ Successfully cleared and refreshed cache!');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`❌ Failed to refresh cache: ${message}`, true);
    }
  }

  private resolveCustomRecordRectype(recordType: string): number | null {
    if (!recordType) return null;
    const upperType = recordType.toUpperCase().trim();
    if (this.mcpTools.customRecordMappings.has(upperType)) {
      return this.mcpTools.customRecordMappings.get(upperType) as number;
    }
    return null;
  }

  async start(): Promise<void> {
    console.error('🚀 NetSuite MCP Server starting...');
    this.isAuthenticated = await this.oauthManager.hasValidSession();

    // Register handlers BEFORE connecting to avoid a window where
    // the server is connected but has no handlers (race condition)
    this.setupHandlers();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Start proactive token refresh if already authenticated
    if (this.isAuthenticated) {
      this.oauthManager.startProactiveRefresh();

      // Fetch custom record mappings and prefetch common metadata in parallel in background
      this.mcpTools.fetchCustomRecordMappings()
        .then(() => this.mcpTools.prefetchCommonMetadata())
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`⚠️ Background prefetch failed: ${message}`);
        });
    }

    console.error('✅ NetSuite MCP Server ready!\n');
  }
}

// Handle uncaught errors — exit so the MCP client can detect the crash and auto-restart
// (matching the behavior of the stable ac1e705 version)
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception in NetSuite MCP Server:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection in NetSuite MCP Server at:', promise, 'reason:', reason);
  process.exit(1);
});

async function main(): Promise<void> {
  try {
    const server = new NetSuiteMCPServer();
    await server.start();
  } catch (error) {
    console.error('❌ Fatal error starting MCP server:', error);
    process.exit(1);
  }
}

main();
