import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'path';
import fs from 'fs/promises';

export function registerResourceHandlers(server: Server, projectRoot: string) {
  // Handle resource listing
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'memory://sql-cheat-sheet',
          name: 'NetSuite SQL Memory & Error Logs',
          mimeType: 'text/markdown',
          description: 'Workspace-specific SQL/SuiteQL cheat sheet, error logs, and lessons learned.'
        }
      ]
    };
  });

  // Handle resource reading
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === 'memory://sql-cheat-sheet') {
      const workspace = projectRoot;
      const memoryFilePath = join(workspace, '.gemini_sql_memory.md');
      
      try {
        let content;
        try {
          content = await fs.readFile(memoryFilePath, 'utf-8');
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            const defaultTemplate = `# Gemini SuiteQL Memory & Lessons Learned\n\n` +
              `> [!IMPORTANT]\n` +
              `> Before writing or modifying any SuiteQL, you MUST read this file and strictly follow the verified rules below to avoid repeating mistakes.\n\n` +
              `## NetSuite SuiteQL Core Rules\n` +
              `1. **[NO GUESSING]** Absolutely never guess NetSuite table or field names based on experience.\n` +
              `2. **[SCHEMA FIRST]** Before writing any query, you must call \`ns_getSuiteQLMetadata\` to retrieve the actual field definitions of the relevant Record type.\n` +
              `3. **[VERIFY JOINS]** Only use a field for JOINs if it is explicitly marked with \`x-n:joinable: true\` in the metadata.\n` +
              `4. **[USE BUILTIN]** Prioritize using the \`BUILTIN.DF(field)\` function to get the display text of related fields, avoiding complex and error-prone JOIN logic.\n` +
              `5. **[CLOSED LOOP]** If a SQL execution error occurs during development, analyze the error, re-verify the Schema, and once resolved, ALWAYS document the correction using the \`netsuite_save_sql_error\` tool.\n\n` +
              `## Historical Errors & Correct Examples (Verified Rules)\n` +
              `*No custom records yet. Once an error is resolved during debugging, the AI will automatically append it here using \`netsuite_save_sql_error\`.*\n`;
            
            await fs.writeFile(memoryFilePath, defaultTemplate, 'utf-8');
            content = defaultTemplate;
          } else {
            throw err;
          }
        }
        
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'text/markdown',
              text: content
            }
          ]
        };
      } catch (error: any) {
        throw new Error(`Failed to read SQL memory: ${error.message}`);
      }
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });
}
