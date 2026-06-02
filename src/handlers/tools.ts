import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { NetSuiteMCPTools } from '../mcp/tools.js';
import { OAuthManager } from '../oauth/manager.js';
import { generateNetSuiteUrl } from '../utils/netsuiteUrls.js';
import { join } from 'path';
import fs from 'fs/promises';

export function registerToolHandlers(
  server: Server,
  oauthManager: OAuthManager,
  mcpTools: NetSuiteMCPTools,
  projectRoot: string,
  handleAuthentication: (args: any) => Promise<any>,
  handleLogout: () => Promise<any>,
  handleCacheRefresh: () => Promise<any>,
  resolveCustomRecordRectype: (type: string) => number | null
) {

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const isAuthenticated = await oauthManager.hasValidSession();
      if (!isAuthenticated) {
        return {
          tools: [
            {
              name: 'netsuite_authenticate',
              description: 'Authenticate with NetSuite to access MCP tools. Required before using any NetSuite tools. If NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables are set, they will be used automatically.',
              inputSchema: {
                type: 'object',
                properties: {
                  accountId: { type: 'string' },
                  clientId: { type: 'string' }
                },
                required: []
              }
            },
            {
              name: 'netsuite_logout',
              description: 'Clear NetSuite authentication session',
              inputSchema: { type: 'object', properties: {} }
            }
          ]
        };
      }

      const tools = await mcpTools.fetchTools();
      const allTools = [
        ...tools,
        {
          name: 'netsuite_get_record_link',
          description: 'Generate a direct NetSuite UI browser link to view/access a specific record in NetSuite.',
          inputSchema: {
            type: 'object',
            properties: {
              recordId: { type: 'string' },
              recordType: { type: 'string' },
              accountId: { type: 'string' },
              rectype: { type: 'integer' }
            },
            required: ['recordId']
          }
        },
        {
          name: 'netsuite_refresh_cache',
          description: 'Force NetSuite to clear and refresh its internal REST session filter set cache.',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'netsuite_logout',
          description: 'Clear NetSuite authentication session and logout',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'netsuite_save_sql_error',
          description: 'Appends a newly discovered SQL/SuiteQL error, its correction, and the rule to the workspace memory file.',
          inputSchema: {
            type: 'object',
            properties: {
              errorDescription: { type: 'string' },
              incorrectSql: { type: 'string' },
              correctSql: { type: 'string' },
              rule: { type: 'string' },
              workspacePath: { type: 'string' }
            },
            required: ['errorDescription', 'incorrectSql', 'correctSql', 'rule']
          }
        },
        {
          name: 'netsuite_run_parallel_queries',
          description: 'Executes multiple SuiteQL queries in parallel using Promise.all.',
          inputSchema: {
            type: 'object',
            properties: {
              queries: { type: 'array', items: { type: 'string' } }
            },
            required: ['queries']
          }
        }
      ];

      return { tools: allTools };
    } catch (error: any) {
      return {
        tools: [
          {
            name: 'netsuite_authenticate',
            description: 'Authenticate with NetSuite to access MCP tools.',
            inputSchema: {
              type: 'object',
              properties: {
                accountId: { type: 'string' },
                clientId: { type: 'string' }
              },
              required: []
            }
          }
        ]
      };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = args || {};

    try {
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
        const { errorDescription, incorrectSql, correctSql, rule, workspacePath } = safeArgs as any;
        const workspace = workspacePath || projectRoot;
        const memoryFilePath = join(workspace, '.gemini_sql_memory.md');
        
        try {
          let content = '';
          try {
            content = await fs.readFile(memoryFilePath, 'utf-8');
          } catch (err: any) {
            if (err.code !== 'ENOENT') throw err;
            content = `# Gemini SuiteQL Memory & Lessons Learned\n\n` +
              `> [!IMPORTANT]\n` +
              `> Before writing or modifying any SuiteQL, you MUST read this file and strictly follow the verified rules below to avoid repeating mistakes.\n\n` +
              `## NetSuite SuiteQL Core Rules\n` +
              `1. **[NO GUESSING]** Absolutely never guess NetSuite table or field names based on experience.\n` +
              `2. **[SCHEMA FIRST]** Before writing any query, you must call \`ns_getSuiteQLMetadata\` to retrieve the actual field definitions of the relevant Record type.\n` +
              `3. **[VERIFY JOINS]** Only use a field for JOINs if it is explicitly marked with \`x-n:joinable: true\` in the metadata.\n` +
              `4. **[USE BUILTIN]** Prioritize using the \`BUILTIN.DF(field)\` function to get the display text of related fields, avoiding complex and error-prone JOIN logic.\n` +
              `5. **[CLOSED LOOP]** If a SQL execution error occurs during development, analyze the error, re-verify the Schema, and once resolved, ALWAYS document the correction using the \`netsuite_save_sql_error\` tool.\n\n` +
              `## Historical Errors & Correct Examples (Verified Rules)\n`;
          }
          
          content = content.replace('*No custom records yet. Once an error is resolved during debugging, the AI will automatically append it here using `netsuite_save_sql_error`.*\n', '');
          content = content.replace('*暂无自定义记录。当您在调试过程中解决报错后，AI 会使用 `netsuite_save_sql_error` 将其自动追加记录于此。*\n', '');
          
          const dateStr = new Date().toISOString().split('T')[0];
          const cleanDesc = (errorDescription || '').replace(/"/g, '\\"').trim();
          const cleanRule = (rule || '').replace(/"/g, '\\"').trim();

          const newEntry = `\n### 📝 Error Record: ${cleanDesc} (${dateStr})\n` +
            `\`\`\`yaml\n` +
            `---\n` +
            `error_description: "${cleanDesc}"\n` +
            `date_recorded: "${dateStr}"\n` +
            `resolved: true\n` +
            `---\n` +
            `\`\`\`\n\n` +
            `- **Incorrect SQL**: \`${(incorrectSql||'').replace(/`/g, '\\`').trim()}\`\n` +
            `- **Correct SQL**: \`${(correctSql||'').replace(/`/g, '\\`').trim()}\`\n` +
            `- **Prevention Rule**: ${cleanRule}\n`;
            
          content += newEntry;
          await fs.writeFile(memoryFilePath, content, 'utf-8');
          
          return {
            content: [{ type: 'text', text: `✅ **Error memory successfully appended to local .gemini_sql_memory.md file!**` }]
          };
        } catch (error: any) {
          return { content: [{ type: 'text', text: `❌ Failed to save error: ${error.message}` }], isError: true };
        }
      }

      if (name === 'netsuite_run_parallel_queries') {
        const { queries } = safeArgs as any;
        if (!Array.isArray(queries) || queries.length === 0) {
          return { content: [{ type: 'text', text: '❌ Invalid arguments: queries must be a non-empty array.' }], isError: true };
        }

        const startTime = Date.now();
        const concurrencyLimit = 5;
        const results = new Array(queries.length);
        let currentQueryIndex = 0;

        const worker = async () => {
          while (currentQueryIndex < queries.length) {
            const index = currentQueryIndex++;
            const sqlQuery = queries[index];
            const queryStart = Date.now();
            try {
              const result = await mcpTools.executeTool('ns_runCustomSuiteQL', { sqlQuery });
              results[index] = {
                index, success: true, durationMs: Date.now() - queryStart, query: sqlQuery,
                result: typeof result === 'string' ? JSON.parse(result) : result
              };
            } catch (err: any) {
              results[index] = {
                index, success: false, durationMs: Date.now() - queryStart, query: sqlQuery,
                error: err.message
              };
            }
          }
        };

        const workers = [];
        for (let i = 0; i < Math.min(concurrencyLimit, queries.length); i++) workers.push(worker());
        await Promise.all(workers);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              totalQueries: queries.length,
              successfulQueries: results.filter(r => r.success).length,
              failedQueries: results.filter(r => !r.success).length,
              totalDurationMs: Date.now() - startTime,
              individualResults: results
            }, null, 2)
          }]
        };
      }

      const isAuthenticated = await oauthManager.hasValidSession();
      if (!isAuthenticated) {
        return {
          content: [{ type: 'text', text: '❌ Not authenticated. Please use the netsuite_authenticate tool first.' }],
          isError: true
        };
      }

      if (name === 'netsuite_get_record_link') {
        const currentAccountId = await oauthManager.getAccountId();
        const targetAccountId = (safeArgs as any).accountId || currentAccountId;
        
        if (!targetAccountId) {
          return { content: [{ type: 'text', text: '❌ Account ID not found.' }], isError: true };
        }

        let rectype = (safeArgs as any).rectype;
        const recordType = (safeArgs as any).recordType;
        if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
          rectype = resolveCustomRecordRectype(recordType);
        }
        
        const url = generateNetSuiteUrl(targetAccountId, recordType, (safeArgs as any).recordId, rectype);
        return { content: [{ type: 'text', text: `🔗 **NetSuite UI Link (${targetAccountId.toUpperCase()}):**\n${url}` }] };
      }

      const result = await mcpTools.executeTool(name, safeArgs as Record<string, any>);
      let responseText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      if (name === 'ns_getRecord' || name === 'ns_createRecord' || name === 'ns_updateRecord') {
        const recordId = (safeArgs as any).id || (safeArgs as any).recordId || (result && typeof result === 'object' && (result.id || result.internalId));
        const recordType = (safeArgs as any).recordType || (safeArgs as any).type || (result && typeof result === 'object' && (result.type || result.recordType));
        
        if (recordId) {
          const currentAccountId = await oauthManager.getAccountId();
          if (currentAccountId) {
            let rectype = (safeArgs as any).rectype;
            if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
              rectype = resolveCustomRecordRectype(recordType);
            }
            const url = generateNetSuiteUrl(currentAccountId, recordType, recordId, rectype);
            if (url) {
              responseText += `\n\n🔗 **NetSuite UI Link (Current Environment):**\n${url}`;
            }
          }
        }
      }

      return { content: [{ type: 'text', text: responseText }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `❌ Error: ${error.message}` }], isError: true };
    }
  });
}
