import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NetSuiteMCPTools } from '../mcp/tools.js';
import { OAuthManager } from '../oauth/manager.js';
import { generateNetSuiteUrl } from '../utils/netsuiteUrls.js';
import { readOrCreateSqlMemory, DEFAULT_SQL_MEMORY_TEMPLATE } from '../utils/sqlMemory.js';
import { asyncJsonParse } from '../utils/json.js';
import { join } from 'path';
import fs from 'fs/promises';

// --- Dependency injection interface (Issue 3.1) ---

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

/** Helper to create a text content response matching MCP SDK's CallToolResult shape */
function textResult(text: string, isError?: boolean): CallToolResult {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) };
}

type ToolResponse = CallToolResult;

// --- Extracted tool handlers (Issue 3.2) ---

async function handleSaveSqlError(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<ToolResponse> {
  const { errorDescription, incorrectSql, correctSql, rule, workspacePath } = args;
  const workspace = (workspacePath as string) || projectRoot;
  const memoryFilePath = join(workspace, '.gemini_sql_memory.md');

  try {
    let content = await readOrCreateSqlMemory(memoryFilePath);

    content = content.replace('*No custom records yet. Once an error is resolved during debugging, the AI will automatically append it here using `netsuite_save_sql_error`.*\n', '');
    content = content.replace('*暂无自定义记录。当您在调试过程中解决报错后，AI 会使用 `netsuite_save_sql_error` 将其自动追加记录于此。*\n', '');

    const dateStr = new Date().toISOString().split('T')[0];
    const cleanDesc = ((errorDescription as string) || '').replace(/"/g, '\\"').trim();
    const cleanRule = ((rule as string) || '').replace(/"/g, '\\"').trim();

    const newEntry = `\n### 📝 Error Record: ${cleanDesc} (${dateStr})\n` +
      `\`\`\`yaml\n` +
      `---\n` +
      `error_description: "${cleanDesc}"\n` +
      `date_recorded: "${dateStr}"\n` +
      `resolved: true\n` +
      `---\n` +
      `\`\`\`\n\n` +
      `- **Incorrect SQL**: \`${((incorrectSql as string) || '').replace(/`/g, '\\`').trim()}\`\n` +
      `- **Correct SQL**: \`${((correctSql as string) || '').replace(/`/g, '\\`').trim()}\`\n` +
      `- **Prevention Rule**: ${cleanRule}\n`;

    content += newEntry;
    await fs.writeFile(memoryFilePath, content, 'utf-8');

    return textResult(`✅ **Error memory successfully appended to local .gemini_sql_memory.md file!**`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`❌ Failed to save error: ${message}`, true);
  }
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

  // Use a semaphore-style approach with clear concurrency control
  const results: Array<Record<string, unknown>> = new Array(queries.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    // Single-threaded JS ensures nextIndex++ is safe across await boundaries
    while (nextIndex < queries.length) {
      const index = nextIndex++;
      const sqlQuery = queries[index] as string;
      const queryStart = Date.now();
      try {
        const result = await mcpTools.executeTool('ns_runCustomSuiteQL', { sqlQuery });
        results[index] = {
          index, success: true, durationMs: Date.now() - queryStart, query: sqlQuery,
          result: typeof result === 'string' ? await asyncJsonParse(result) : result
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results[index] = {
          index, success: false, durationMs: Date.now() - queryStart, query: sqlQuery,
          error: message
        };
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrencyLimit, queries.length); i++) workers.push(worker());
  await Promise.all(workers);

  return textResult(JSON.stringify({
    totalQueries: queries.length,
    successfulQueries: results.filter(r => r.success).length,
    failedQueries: results.filter(r => !r.success).length,
    totalDurationMs: Date.now() - startTime,
    individualResults: results
  }, null, 2));
}

async function handleGetRecordLink(
  args: Record<string, unknown>,
  oauthManager: OAuthManager,
  resolveCustomRecordRectype: (type: string) => number | null
): Promise<ToolResponse> {
  const currentAccountId = await oauthManager.getAccountId();
  const targetAccountId = (args.accountId as string) || currentAccountId;

  if (!targetAccountId) {
    return textResult('❌ Account ID not found.', true);
  }

  let rectype = args.rectype as number | string | undefined;
  const recordType = args.recordType as string | undefined;
  if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
    rectype = resolveCustomRecordRectype(recordType) ?? undefined;
  }

  const url = generateNetSuiteUrl(targetAccountId, recordType, args.recordId as string, rectype);
  return textResult(`🔗 **NetSuite UI Link (${targetAccountId.toUpperCase()}):**\n${url}`);
}

/** Append a NetSuite UI deep link to the response text for record operations */
async function appendRecordLink(
  responseText: string,
  args: Record<string, unknown>,
  result: unknown,
  oauthManager: OAuthManager,
  resolveCustomRecordRectype: (type: string) => number | null
): Promise<string> {
  const resultObj = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
  const recordId = (args.id || args.recordId || resultObj.id || resultObj.internalId) as string | undefined;
  const recordType = (args.recordType || args.type || resultObj.type || resultObj.recordType) as string | undefined;

  if (!recordId) return responseText;

  const currentAccountId = await oauthManager.getAccountId();
  if (!currentAccountId) return responseText;

  let rectype = args.rectype as number | string | undefined;
  if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
    rectype = resolveCustomRecordRectype(recordType) ?? undefined;
  }
  const url = generateNetSuiteUrl(currentAccountId, recordType, recordId, rectype);
  if (url) {
    responseText += `\n\n🔗 **NetSuite UI Link (Current Environment):**\n${url}`;
  }

  return responseText;
}


// --- Tool definitions ---

const AUTH_TOOL = {
  name: 'netsuite_authenticate',
  description: 'Authenticate with NetSuite to access MCP tools. Required before using any NetSuite tools. If NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables are set, they will be used automatically.',
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
  description: 'Clear NetSuite authentication session and logout',
  inputSchema: { type: 'object' as const, properties: {} }
};

const RECORD_LINK_TOOL = {
  name: 'netsuite_get_record_link',
  description: 'Generate a direct NetSuite UI browser link to view/access a specific record in NetSuite.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      recordId: {
        type: 'string',
        description: 'Internal ID of the NetSuite record.'
      },
      recordType: {
        type: 'string',
        description: 'Record type identifier (e.g. salesorder, customer, customrecord_xxx).'
      },
      accountId: {
        type: 'string',
        description: 'Override account ID (defaults to current authenticated account).'
      },
      rectype: {
        type: 'integer',
        description: 'Numeric custom record type ID. Auto-resolved from recordType if omitted.'
      }
    },
    required: ['recordId']
  }
};

const REFRESH_CACHE_TOOL = {
  name: 'netsuite_refresh_cache',
  description: 'Force NetSuite to clear and refresh its internal REST session filter set cache.',
  inputSchema: { type: 'object' as const, properties: {} }
};

const SAVE_SQL_ERROR_TOOL = {
  name: 'netsuite_save_sql_error',
  description: 'Appends a newly discovered SQL/SuiteQL error, its correction, and the rule to the workspace memory file.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      errorDescription: { type: 'string', description: 'Brief description of the SQL error encountered.' },
      incorrectSql: { type: 'string', description: 'The incorrect SQL query that caused the error.' },
      correctSql: { type: 'string', description: 'The corrected SQL query.' },
      rule: { type: 'string', description: 'Prevention rule to avoid this error in the future.' },
      workspacePath: { type: 'string', description: 'Override workspace path for the memory file.' }
    },
    required: ['errorDescription', 'incorrectSql', 'correctSql', 'rule']
  }
};

const PARALLEL_QUERIES_TOOL = {
  name: 'netsuite_run_parallel_queries',
  description: 'Executes multiple SuiteQL queries concurrently in parallel (max 5 concurrent). ALWAYS use this tool instead of calling ns_runCustomSuiteQL multiple times sequentially when you need to execute two or more queries (e.g. fetching related data, batch querying multiple tables, or retrieving multiple pages of results). You can construct individual queries with custom pagination ranges using ROWNUM if needed.',
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

const LOCAL_TOOLS = [RECORD_LINK_TOOL, REFRESH_CACHE_TOOL, LOGOUT_TOOL, SAVE_SQL_ERROR_TOOL, PARALLEL_QUERIES_TOOL];

// --- Main registration ---

export function registerToolHandlers(deps: ToolHandlerDeps): void {
  const { server, oauthManager, mcpTools, projectRoot,
    handleAuthentication, handleLogout, handleCacheRefresh, resolveCustomRecordRectype } = deps;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const isAuthenticated = await oauthManager.hasValidSession();
      if (!isAuthenticated) {
        return { tools: [AUTH_TOOL, LOGOUT_TOOL] };
      }

      const tools = await mcpTools.fetchTools() as Array<Record<string, unknown>>;
      const filteredTools = tools.filter(tool => tool.name !== 'ns_createRecord' && tool.name !== 'ns_updateRecord');
      const modifiedTools = filteredTools.map((tool) => {
        if (tool.name === 'ns_runCustomSuiteQL') {
          return {
            ...tool,
            description: `${tool.description || ''}\n\n🚨 WARNING: If you need to execute two or more SuiteQL queries, do NOT call this tool sequentially. Instead, combine them and call the parallel tool 'netsuite_run_parallel_queries' to run them concurrently (up to 5 concurrent queries).`
          };
        }
        return tool;
      });
      return { tools: [...modifiedTools, ...LOCAL_TOOLS] };
    } catch {
      return { tools: [AUTH_TOOL] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args || {}) as Record<string, unknown>;

    try {
      // --- Local tools that don't require authentication ---
      if (name === 'netsuite_authenticate') {
        return await handleAuthentication(safeArgs);
      }
      if (name === 'netsuite_logout') {
        return await handleLogout();
      }
      if (name === 'netsuite_refresh_cache') {
        return await handleCacheRefresh();
      }
      if (name === 'netsuite_save_sql_error') {
        return await handleSaveSqlError(safeArgs, projectRoot);
      }
      if (name === 'netsuite_run_parallel_queries') {
        return await handleRunParallelQueries(safeArgs, mcpTools);
      }

      // --- Block write operations ---
      if (name === 'ns_createRecord' || name === 'ns_updateRecord') {
        throw new McpError(ErrorCode.InvalidRequest, `Write operations are disabled to ensure data accuracy: ${name}`);
      }

      // --- Tools requiring authentication ---
      const isAuthenticated = await oauthManager.hasValidSession();
      if (!isAuthenticated) {
        return textResult('❌ Not authenticated. Please use the netsuite_authenticate tool first.', true);
      }

      if (name === 'netsuite_get_record_link') {
        return await handleGetRecordLink(safeArgs, oauthManager, resolveCustomRecordRectype);
      }

      // --- Proxy to NetSuite MCP API ---
      const result = await mcpTools.executeTool(name, safeArgs);
      let responseText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      // Auto-append UI deep link for record CRUD operations
      if (name === 'ns_getRecord' || name === 'ns_createRecord' || name === 'ns_updateRecord') {
        responseText = await appendRecordLink(responseText, safeArgs, result, oauthManager, resolveCustomRecordRectype);
      }

      return textResult(responseText);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`❌ Error: ${message}`, true);
    }
  });
}
