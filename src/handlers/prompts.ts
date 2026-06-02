import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'path';
import fs from 'fs/promises';

export function registerPromptHandlers(server: Server, projectRoot: string) {
  // Handle prompts listing
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: 'netsuite-sql-expert',
          description: 'Start a NetSuite SuiteQL debugging or authoring session with historical memory context injected.',
          arguments: [
            {
              name: 'task',
              description: 'What do you want to query or debug?',
              required: true
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
      const workspace = projectRoot;
      const memoryFilePath = join(workspace, '.gemini_sql_memory.md');
      let memoryContent = 'No memory file found.';
      try {
        memoryContent = await fs.readFile(memoryFilePath, 'utf-8');
      } catch(e) {}

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
    throw new Error(`Prompt not found: ${request.params.name}`);
  });
}
