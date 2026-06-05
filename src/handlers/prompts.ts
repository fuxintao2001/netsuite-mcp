import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'path';
import fs from 'fs/promises';

export function registerPromptHandlers(server: Server, projectRoot: string): void {
  // Handle prompts listing — declare the available prompt so clients can discover it
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: 'netsuite-sql-expert',
          description: 'Injects SuiteQL cheat sheet and historical error context to assist with query writing.',
          arguments: [
            {
              name: 'task',
              description: 'The SQL/SuiteQL task you need help with.',
              required: false
            }
          ]
        }
      ]
    };
  });

  // Handle prompt execution
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name === 'netsuite-sql-expert') {
      const task = request.params.arguments?.task || 'Help me write a SuiteQL query.';
      
      // Read memory file content dynamically
      const memoryFilePath = join(projectRoot, '.gemini_sql_memory.md');
      let memoryContent = 'No memory file found.';
      try {
        memoryContent = await fs.readFile(memoryFilePath, 'utf-8');
      } catch {
        // File not found — use default message
      }

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `I need your help as a NetSuite SuiteQL Expert.\n\nTask: ${task}\n\nPlease review the attached SQL cheat sheet and historical errors before proceeding.`
            }
          },
          {
            role: 'user',
            content: {
              type: 'resource',
              resource: {
                uri: 'memory://sql-cheat-sheet',
                mimeType: 'text/markdown',
                text: memoryContent
              }
            }
          }
        ]
      };
    }
    throw new McpError(ErrorCode.MethodNotFound, `Prompt not found: ${request.params.name}`);
  });
}
