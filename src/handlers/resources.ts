import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'path';
import { readOrCreateSqlMemory } from '../utils/sqlMemory.js';

export function registerResourceHandlers(server: Server, projectRoot: string): void {
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
      const memoryFilePath = join(projectRoot, '.gemini_sql_memory.md');
      
      try {
        const content = await readOrCreateSqlMemory(memoryFilePath);
        
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'text/markdown',
              text: content
            }
          ]
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new McpError(ErrorCode.InternalError, `Failed to read SQL memory: ${message}`);
      }
    }
    throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${request.params.uri}`);
  });
}
