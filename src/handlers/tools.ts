import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import { NetSuiteMCPTools } from '../mcp/tools.js';
import { OAuthManager } from '../oauth/manager.js';
import { generateNetSuiteUrl } from '../utils/netsuiteUrls.js';
import { asyncJsonParse } from '../utils/json.js';
import { cacheService } from '../utils/cache.js';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Create a text content response matching the MCP SDK CallToolResult shape. */
export function textResult(text: string, isError?: boolean): CallToolResult {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) };
}

type ToolResponse = CallToolResult;

// ---------------------------------------------------------------------------
// Workspace checking helpers for physical isolation
// ---------------------------------------------------------------------------

function matchesAccount(defaultAuthId: string, serverAccountId: string): boolean {
  if (!defaultAuthId || !serverAccountId) return false;
  const normalize = (str: string) => str.toUpperCase().replace(/[-_]/g, '');
  const normalizedServer = normalize(serverAccountId);
  const normalizedAuth = normalize(defaultAuthId);

  if (!normalizedAuth.startsWith(normalizedServer)) {
    return false;
  }

  const serverIsSandbox = serverAccountId.toUpperCase().includes('_SB') ||
                          serverAccountId.toUpperCase().includes('-SB') ||
                          serverAccountId.toUpperCase().startsWith('TSTDRV');

  const projectIsSandbox = defaultAuthId.toUpperCase().includes('_SB') ||
                           defaultAuthId.toUpperCase().includes('-SB') ||
                           defaultAuthId.toUpperCase().startsWith('TSTDRV');

  if (!serverIsSandbox && projectIsSandbox) {
    return false;
  }

  return true;
}

async function checkWorkspaceMatch(server: Server, oauthManager: OAuthManager): Promise<boolean> {
  const accountId = (await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
  if (!accountId) return true; // Can't determine account ID, allow by default

  try {
    const rootsResult = await server.listRoots();
    if (!rootsResult || !Array.isArray(rootsResult.roots) || rootsResult.roots.length === 0) {
      return true; // No roots returned, fallback to allow
    }

    let hasNetSuiteWorkspace = false;
    let hasMatchingWorkspace = false;

    for (const root of rootsResult.roots) {
      try {
        if (root.uri.startsWith('file://')) {
          const workspacePath = fileURLToPath(root.uri);
          const projectJsonPath = join(workspacePath, 'project.json');
          const projectJsonContent = await fs.readFile(projectJsonPath, 'utf-8');
          const projectConfig = JSON.parse(projectJsonContent);
          const defaultAuthId = projectConfig.defaultAuthId;

          if (defaultAuthId) {
            hasNetSuiteWorkspace = true;
            if (matchesAccount(defaultAuthId, accountId)) {
              hasMatchingWorkspace = true;
              break;
            }
          }
        }
      } catch {
        // Ignore file read/parse errors for this root
      }
    }

    // If there are NetSuite workspaces open, we require at least one matching workspace.
    // If no NetSuite workspaces are open, we allow it.
    if (hasNetSuiteWorkspace && !hasMatchingWorkspace) {
      return false;
    }
  } catch {
    // If listRoots fails or is not supported by client, fallback to allow
  }

  return true;
}

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface ToolHandlerDeps {
  server: Server;
  oauthManager: OAuthManager;
  mcpTools: NetSuiteMCPTools;
  projectRoot: string;
  handleAuthentication: (args: Record<string, unknown>) => Promise<ToolResponse>;
  handleLogout: () => Promise<ToolResponse>;
  handleCacheRefresh: () => Promise<ToolResponse>;
  resolveCustomRecordRectype: (type: string) => number | null;
}

// ---------------------------------------------------------------------------
// Local tool handlers
// ---------------------------------------------------------------------------

async function handleGetRecordLink(
  args: Record<string, unknown>,
  oauthManager: OAuthManager,
  resolveRectype: (type: string) => number | null
): Promise<ToolResponse> {
  const currentAccountId = await oauthManager.getAccountId();
  const targetAccountId = (args.accountId as string) || currentAccountId;

  if (!targetAccountId) {
    return textResult('❌ Account ID not found.', true);
  }

  let rectype = args.rectype as number | string | undefined;
  const recordType = args.recordType as string | undefined;
  if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
    rectype = resolveRectype(recordType) ?? undefined;
  }

  const url = generateNetSuiteUrl(targetAccountId, recordType, args.recordId as string, rectype);
  return textResult(`🔗 **NetSuite UI Link (${targetAccountId.toUpperCase()}):**\n${url}`);
}

async function handleRunParallelQueries(
  args: Record<string, unknown>,
  mcpTools: NetSuiteMCPTools
): Promise<ToolResponse> {
  const { queries } = args;
  if (!Array.isArray(queries) || queries.length === 0) {
    return textResult('❌ Invalid arguments: queries must be a non-empty array.', true);
  }

  const startTime = Date.now();
  const concurrencyLimit = 5;
  const results: Array<Record<string, unknown>> = new Array(queries.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < queries.length) {
      const index = nextIndex++;
      const sqlQuery = queries[index] as string;
      const queryStart = Date.now();
      try {
        const result = await mcpTools.executeTool('ns_runCustomSuiteQL', { sqlQuery });
        results[index] = {
          index, success: true, durationMs: Date.now() - queryStart,
          query: sqlQuery,
          result: typeof result === 'string' ? await asyncJsonParse(result) : result
        };
      } catch (err: unknown) {
        results[index] = {
          index, success: false, durationMs: Date.now() - queryStart,
          query: sqlQuery,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrencyLimit, queries.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return textResult(JSON.stringify({
    totalQueries: queries.length,
    successfulQueries: results.filter(r => r.success).length,
    failedQueries: results.filter(r => !r.success).length,
    totalDurationMs: Date.now() - startTime,
    individualResults: results
  }, null, 2));
}

/**
 * netsuite_status — Diagnostic tool
 */
async function handleStatus(
  oauthManager: OAuthManager
): Promise<ToolResponse> {
  const sessionInfo = await oauthManager.getSessionInfo();
  const cacheStats = cacheService.getStats();

  const status: Record<string, unknown> = {
    server: 'netsuite-mcp',
    version: '1.0.0',
    authenticated: sessionInfo.authenticated,
    refreshSchedulerActive: sessionInfo.refreshSchedulerActive,
    cache: cacheStats
  };

  if (sessionInfo.authenticated) {
    status.accountId = sessionInfo.accountId;
    status.clientId = sessionInfo.clientId ? `${sessionInfo.clientId.substring(0, 8)}...` : undefined;
    status.tokenExpiresIn = sessionInfo.tokenExpiresIn !== undefined
      ? `${sessionInfo.tokenExpiresIn}s`
      : 'unknown';
    status.tokenExpiresAt = sessionInfo.tokenExpiresAt
      ? new Date(sessionInfo.tokenExpiresAt).toISOString()
      : 'unknown';

    const isSandbox = sessionInfo.accountId
      ? (sessionInfo.accountId.toUpperCase().includes('_SB') || sessionInfo.accountId.toUpperCase().includes('-SB') || sessionInfo.accountId.toUpperCase().startsWith('TSTDRV'))
      : false;
    status.environment = isSandbox ? 'Sandbox/Test' : 'Production';
    status.writeOperations = isSandbox ? 'enabled' : 'disabled';
  }

  return textResult(JSON.stringify(status, null, 2));
}

/** Append a NetSuite UI deep link to a record operation response. */
async function appendRecordLink(
  responseText: string,
  args: Record<string, unknown>,
  result: unknown,
  oauthManager: OAuthManager,
  resolveRectype: (type: string) => number | null
): Promise<string> {
  const resultObj = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
  const recordId = (args.id || args.recordId || resultObj.id || resultObj.internalId) as string | undefined;
  const recordType = (args.recordType || args.type || resultObj.type || resultObj.recordType) as string | undefined;

  if (!recordId) return responseText;

  const currentAccountId = await oauthManager.getAccountId();
  if (!currentAccountId) return responseText;

  let rectype = args.rectype as number | string | undefined;
  if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
    rectype = resolveRectype(recordType) ?? undefined;
  }

  const url = generateNetSuiteUrl(currentAccountId, recordType, recordId, rectype);
  if (url) {
    responseText += `\n\n🔗 **NetSuite UI Link (Current Environment):**\n${url}`;
  }
  return responseText;
}

// ---------------------------------------------------------------------------
// Tool definitions (schemas)
// ---------------------------------------------------------------------------

const AUTH_TOOL = {
  name: 'netsuite_authenticate',
  description: 'Authenticate with NetSuite using OAuth 2.0 PKCE. Required before using any NetSuite tools. If NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables are set, they will be used automatically.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      accountId: {
        type: 'string',
        description: 'NetSuite Account ID (e.g. 1234567 or 1234567_SB1). Falls back to NETSUITE_ACCOUNT_ID env var.'
      },
      clientId: {
        type: 'string',
        description: 'OAuth 2.0 Client ID from NetSuite integration record. Falls back to NETSUITE_CLIENT_ID env var.'
      }
    },
    required: []
  }
};

const LOGOUT_TOOL = {
  name: 'netsuite_logout',
  description: 'Clear NetSuite authentication session and logout.',
  inputSchema: { type: 'object' as const, properties: {} }
};

const RECORD_LINK_TOOL = {
  name: 'netsuite_get_record_link',
  description: 'Generate a direct NetSuite UI browser link to view a specific record.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      recordId: { type: 'string', description: 'Internal ID of the NetSuite record.' },
      recordType: { type: 'string', description: 'Record type (e.g. salesorder, customer, customrecord_xxx).' },
      accountId: { type: 'string', description: 'Override account ID (defaults to current authenticated account).' },
      rectype: { type: 'integer', description: 'Numeric custom record type ID. Auto-resolved if omitted.' }
    },
    required: ['recordId']
  }
};

const REFRESH_CACHE_TOOL = {
  name: 'netsuite_refresh_cache',
  description: 'Force clear local cache and refresh NetSuite internal REST session cache.',
  inputSchema: { type: 'object' as const, properties: {} }
};

const PARALLEL_QUERIES_TOOL = {
  name: 'netsuite_run_parallel_queries',
  description: 'Execute multiple SuiteQL queries concurrently (max 5). Use this instead of calling ns_runCustomSuiteQL multiple times sequentially.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of SuiteQL query strings to execute in parallel.'
      }
    },
    required: ['queries']
  }
};

const STATUS_TOOL = {
  name: 'netsuite_status',
  description: 'Show diagnostic information: authentication state, token expiry, account details, cache statistics, and environment type.',
  inputSchema: { type: 'object' as const, properties: {} }
};

const LOCAL_TOOLS = [RECORD_LINK_TOOL, REFRESH_CACHE_TOOL, LOGOUT_TOOL, PARALLEL_QUERIES_TOOL, STATUS_TOOL];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all MCP tool handlers on the server.
 *
 * Error handling contract:
 * - McpError → rethrown to MCP SDK (protocol-level error)
 * - All other errors → returned as textResult with isError: true
 */
export function registerToolHandlers(deps: ToolHandlerDeps): void {
  const {
    server, oauthManager, mcpTools, handleAuthentication,
    handleLogout, handleCacheRefresh, resolveCustomRecordRectype
  } = deps;

  // --- List Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const isMatch = await checkWorkspaceMatch(server, oauthManager);
      if (!isMatch) {
        return { tools: [] };
      }

      const accountId = (await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
      const isSandbox = accountId
        ? (accountId.toUpperCase().includes('_SB') || accountId.toUpperCase().includes('-SB') || accountId.toUpperCase().startsWith('TSTDRV'))
        : false;

      const envSuffix = accountId
        ? ` [Account: ${accountId}, Env: ${isSandbox ? 'Sandbox' : 'Production'}]`
        : '';

      const isAuthenticated = await oauthManager.hasValidSession();
      if (!isAuthenticated) {
        const unauthTools = [AUTH_TOOL, LOGOUT_TOOL].map(t => {
          const originalDesc = (t.description as string) || '';
          return {
            ...t,
            description: originalDesc ? `${originalDesc}${envSuffix}` : envSuffix
          };
        });
        return { tools: unauthTools };
      }

      const tools = await mcpTools.fetchTools() as Array<Record<string, unknown>>;

      // Filter write tools in production
      const filteredTools = isSandbox
        ? tools
        : tools.filter(t => t.name !== 'ns_createRecord' && t.name !== 'ns_updateRecord');

      // Enhance ns_runCustomSuiteQL description to guide parallel execution
      const mappedTools = filteredTools.map(t => {
        if (t.name === 'ns_runCustomSuiteQL') {
          const originalDesc = (t.description as string) || '';
          const suffix = '\n⚠️ CRITICAL: If you need to execute two or more independent SuiteQL queries, you MUST use the \'netsuite_run_parallel_queries\' tool to run them concurrently. Do NOT call this tool (\'ns_runCustomSuiteQL\') multiple times sequentially unless a subsequent query depends on the output of a previous one.';
          return {
            ...t,
            description: originalDesc ? `${originalDesc}${suffix}` : suffix
          };
        }
        return t;
      });

      const finalTools = [...mappedTools, ...LOCAL_TOOLS].map(t => {
        const originalDesc = (t.description as string) || '';
        return {
          ...t,
          description: originalDesc ? `${originalDesc}${envSuffix}` : envSuffix
        };
      });

      return { tools: finalTools };
    } catch {
      const accountId = (await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
      const isSandbox = accountId
        ? (accountId.toUpperCase().includes('_SB') || accountId.toUpperCase().includes('-SB') || accountId.toUpperCase().startsWith('TSTDRV'))
        : false;
      const envSuffix = accountId
        ? ` [Account: ${accountId}, Env: ${isSandbox ? 'Sandbox' : 'Production'}]`
        : '';
      const fallbackTools = [AUTH_TOOL].map(t => {
        const originalDesc = (t.description as string) || '';
        return {
          ...t,
          description: originalDesc ? `${originalDesc}${envSuffix}` : envSuffix
        };
      });
      return { tools: fallbackTools };
    }
  });

  // --- Call Tool ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args || {}) as Record<string, unknown>;

    try {
      const isMatch = await checkWorkspaceMatch(server, oauthManager);
      if (!isMatch) {
        const accountId = (await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
        throw new McpError(
          ErrorCode.InvalidRequest,
          `This tool is disabled because the active workspace does not match the NetSuite account (${accountId}) for this server instance.`
        );
      }

      // --- Tools that do NOT require authentication ---
      if (name === 'netsuite_authenticate') {
        return await handleAuthentication(safeArgs);
      }
      if (name === 'netsuite_logout') {
        return await handleLogout();
      }

      // --- All remaining tools require authentication ---
      const isAuthenticated = await oauthManager.hasValidSession();
      if (!isAuthenticated) {
        return textResult('❌ Not authenticated. Please use the netsuite_authenticate tool first.', true);
      }

      // --- Local tools (authenticated) ---
      if (name === 'netsuite_refresh_cache') {
        return await handleCacheRefresh();
      }
      if (name === 'netsuite_get_record_link') {
        return await handleGetRecordLink(safeArgs, oauthManager, resolveCustomRecordRectype);
      }
      if (name === 'netsuite_run_parallel_queries') {
        return await handleRunParallelQueries(safeArgs, mcpTools);
      }
      if (name === 'netsuite_status') {
        return await handleStatus(oauthManager);
      }

      // --- Block write operations in production ---
      if (name === 'ns_createRecord' || name === 'ns_updateRecord') {
        const accountId = await oauthManager.getAccountId();
        const isSandbox = accountId
          ? (accountId.toUpperCase().includes('_SB') || accountId.toUpperCase().includes('-SB') || accountId.toUpperCase().startsWith('TSTDRV'))
          : false;

        if (!isSandbox) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Write operations are disabled in production environments: ${name}`
          );
        }
      }

      // --- Proxy to NetSuite MCP API ---
      const result = await mcpTools.executeTool(name, safeArgs);
      let responseText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      // Auto-append UI deep link for record operations
      if (name === 'ns_getRecord' || name === 'ns_createRecord' || name === 'ns_updateRecord') {
        responseText = await appendRecordLink(responseText, safeArgs, result, oauthManager, resolveCustomRecordRectype);
      }

      return textResult(responseText);
    } catch (error: unknown) {
      // Let McpError propagate directly to the MCP SDK
      if (error instanceof McpError) {
        throw error;
      }
      // All other errors: return as tool-level error response
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`❌ Error: ${message}`, true);
    }
  });
}
