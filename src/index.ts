#!/usr/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OAuthManager } from './oauth/manager.js';
import { NetSuiteMCPTools } from './mcp/tools.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Import Handlers
import { registerResourceHandlers } from './handlers/resources.js';
import { registerPromptHandlers } from './handlers/prompts.js';
import { registerToolHandlers } from './handlers/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname); // Go up one level from dist/ or src/ to project root

class NetSuiteMCPServer {
  oauthManager: OAuthManager;
  mcpTools: NetSuiteMCPTools;
  isAuthenticated: boolean;
  server: Server;

  constructor() {
    const sessionsPath = process.env.NETSUITE_SESSION_PATH || (process.env.NETSUITE_ACCOUNT_ID 
      ? join(projectRoot, 'sessions', process.env.NETSUITE_ACCOUNT_ID.toLowerCase()) 
      : join(projectRoot, 'sessions'));

    const callbackPort = parseInt(process.env.OAUTH_CALLBACK_PORT || '8080', 10);

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

  setupHandlers() {
    registerResourceHandlers(this.server, projectRoot);
    registerPromptHandlers(this.server, projectRoot);
    registerToolHandlers(
      this.server,
      this.oauthManager,
      this.mcpTools,
      projectRoot,
      this.handleAuthentication.bind(this),
      this.handleLogout.bind(this),
      this.handleCacheRefresh.bind(this),
      this.resolveCustomRecordRectype.bind(this)
    );
  }

  async handleAuthentication(args: any) {
    const accountId = args.accountId || process.env.NETSUITE_ACCOUNT_ID;
    const clientId = args.clientId || process.env.NETSUITE_CLIENT_ID;

    if (!accountId || !clientId) {
      return {
        content: [{ type: 'text', text: '❌ Missing required credentials.' }],
        isError: true
      };
    }

    try {
      console.error('\n🔐 Starting NetSuite authentication...');
      await this.oauthManager.startAuthFlow({ accountId, clientId });
      this.isAuthenticated = true;
      this.mcpTools.clearCache();
      return { content: [{ type: 'text', text: '✅ Successfully authenticated with NetSuite!' }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `❌ Authentication failed: ${error.message}` }], isError: true };
    }
  }

  async handleLogout() {
    try {
      await this.oauthManager.clearSession();
      this.mcpTools.clearCache();
      this.isAuthenticated = false;
      return { content: [{ type: 'text', text: '✅ Successfully logged out from NetSuite.' }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `❌ Logout failed: ${error.message}` }], isError: true };
    }
  }

  async handleCacheRefresh() {
    try {
      await this.mcpTools.refreshSessionCache();
      await this.mcpTools.clearMetadataCache();
      return { content: [{ type: 'text', text: '✅ Successfully cleared and refreshed cache!' }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `❌ Failed to refresh cache: ${error.message}` }], isError: true };
    }
  }

  resolveCustomRecordRectype(recordType: string): number | null {
    if (!recordType) return null;
    const upperType = recordType.toUpperCase().trim();
    if (this.mcpTools.customRecordMappings.has(upperType)) {
      return this.mcpTools.customRecordMappings.get(upperType) as number;
    }
    return null;
  }

  async start() {
    console.error('🚀 NetSuite MCP Server starting...');
    this.isAuthenticated = await this.oauthManager.hasValidSession();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.setupHandlers();
    console.error('✅ NetSuite MCP Server ready!\n');
  }
}

async function main() {
  try {
    const server = new NetSuiteMCPServer();
    await server.start();
  } catch (error) {
    process.exit(1);
  }
}

main();
