import { registerToolHandlers } from './tools.js';
import { registerResourceHandlers } from './resources.js';
import { registerPromptHandlers } from './prompts.js';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';

describe('MCP Handlers', () => {
  let mockServer: any;
  let mockOAuthManager: any;
  let mockMCPTools: any;
  const testWorkspace = path.join(process.cwd(), '.test-handlers-workspace');

  let toolHandlers: Map<any, Function>;

  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.rm(testWorkspace, { recursive: true, force: true });
    await fs.mkdir(testWorkspace, { recursive: true });

    toolHandlers = new Map();
    mockServer = {
      setRequestHandler: jest.fn((schema: any, handler: Function) => {
        toolHandlers.set(schema, handler);
      })
    };

    mockOAuthManager = {
      hasValidSession: jest.fn().mockResolvedValue(true),
      getAccountId: jest.fn().mockResolvedValue('test-account'),
      ensureValidToken: jest.fn().mockResolvedValue('token-123')
    };

    mockMCPTools = {
      fetchTools: jest.fn().mockResolvedValue([
        { name: 'ns_getRecord', description: 'Get a NetSuite record' }
      ]),
      executeTool: jest.fn().mockResolvedValue('{}'),
      customRecordMappings: new Map()
    };
  });

  afterEach(async () => {
    await fs.rm(testWorkspace, { recursive: true, force: true });
  });

  describe('Resources Handler', () => {
    it('should register and return resources list', async () => {
      registerResourceHandlers(mockServer, testWorkspace);
      const listHandler = toolHandlers.get(ListResourcesRequestSchema);
      expect(listHandler).toBeDefined();

      const result = await listHandler!();
      expect(result.resources).toContainEqual(expect.objectContaining({
        uri: 'memory://sql-cheat-sheet'
      }));
    });

    it('should create default template if memory file does not exist', async () => {
      registerResourceHandlers(mockServer, testWorkspace);
      const readHandler = toolHandlers.get(ReadResourceRequestSchema);
      expect(readHandler).toBeDefined();

      const result = await readHandler!({ params: { uri: 'memory://sql-cheat-sheet' } });
      expect(result.contents[0].text).toContain('# Gemini SuiteQL Memory & Lessons Learned');

      // Verify file was written
      const fileExists = await fs.stat(path.join(testWorkspace, '.gemini_sql_memory.md')).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);
    });

    it('should read existing memory file correctly', async () => {
      const customContent = '# My Custom SQL Rules';
      await fs.writeFile(path.join(testWorkspace, '.gemini_sql_memory.md'), customContent, 'utf-8');

      registerResourceHandlers(mockServer, testWorkspace);
      const readHandler = toolHandlers.get(ReadResourceRequestSchema);
      const result = await readHandler!({ params: { uri: 'memory://sql-cheat-sheet' } });
      expect(result.contents[0].text).toBe(customContent);
    });
  });

  describe('Prompts Handler', () => {
    it('should register and return available prompts list', async () => {
      registerPromptHandlers(mockServer, testWorkspace);
      const listHandler = toolHandlers.get(ListPromptsRequestSchema);
      expect(listHandler).toBeDefined();

      const result = await listHandler!();
      expect(result.prompts).toContainEqual(expect.objectContaining({
        name: 'netsuite-sql-expert'
      }));
    });

    it('should resolve prompt with dynamic memory content', async () => {
      const customContent = 'Rule X: SELECT *';
      await fs.writeFile(path.join(testWorkspace, '.gemini_sql_memory.md'), customContent, 'utf-8');

      registerPromptHandlers(mockServer, testWorkspace);
      const getHandler = toolHandlers.get(GetPromptRequestSchema);
      
      const result = await getHandler!({
        params: {
          name: 'netsuite-sql-expert',
          arguments: { task: 'Fetch accounts' }
        }
      });

      expect(result.messages[0].content.text).toContain('Fetch accounts');
      expect(result.messages[1].content.resource.text).toBe(customContent);
    });
  });

  describe('Tools Handler', () => {
    let authenticateCallback: any;
    let logoutCallback: any;
    let refreshCallback: any;
    let resolveRectypeCallback: any;

    beforeEach(() => {
      authenticateCallback = jest.fn();
      logoutCallback = jest.fn();
      refreshCallback = jest.fn();
      resolveRectypeCallback = jest.fn().mockReturnValue(null);

      registerToolHandlers({
        server: mockServer,
        oauthManager: mockOAuthManager,
        mcpTools: mockMCPTools,
        projectRoot: testWorkspace,
        handleAuthentication: authenticateCallback,
        handleLogout: logoutCallback,
        handleCacheRefresh: refreshCallback,
        resolveCustomRecordRectype: resolveRectypeCallback
      });
    });

    it('should register tools and list authenticated tools', async () => {
      const listHandler = toolHandlers.get(ListToolsRequestSchema);
      expect(listHandler).toBeDefined();

      const result = await listHandler!();
      // Authenticated list includes fetchTools + our custom handlers
      const names = result.tools.map((t: any) => t.name);
      expect(names).toContain('ns_getRecord');
      expect(names).toContain('netsuite_get_record_link');
      expect(names).toContain('netsuite_save_sql_error');
      expect(names).toContain('netsuite_run_parallel_queries');
    });

    it('should invoke authenticate callback on netsuite_authenticate call', async () => {
      const callHandler = toolHandlers.get(CallToolRequestSchema);
      await callHandler!({
        params: {
          name: 'netsuite_authenticate',
          arguments: { accountId: '123', clientId: '456' }
        }
      });

      expect(authenticateCallback).toHaveBeenCalledWith({ accountId: '123', clientId: '456' });
    });

    it('should append SuiteQL error to memory file on netsuite_save_sql_error call', async () => {
      const callHandler = toolHandlers.get(CallToolRequestSchema);
      await callHandler!({
        params: {
          name: 'netsuite_save_sql_error',
          arguments: {
            errorDescription: 'test error',
            incorrectSql: 'SELECT x',
            correctSql: 'SELECT y',
            rule: 'Avoid x',
            workspacePath: testWorkspace
          }
        }
      });

      const memoryFilePath = path.join(testWorkspace, '.gemini_sql_memory.md');
      const content = await fs.readFile(memoryFilePath, 'utf-8');
      expect(content).toContain('test error');
      expect(content).toContain('SELECT x');
      expect(content).toContain('SELECT y');
      expect(content).toContain('Avoid x');
    });

    it('should run parallel queries using parallel worker pools', async () => {
      const mockResult1 = JSON.stringify({ data: [1] });
      const mockResult2 = JSON.stringify({ data: [2] });
      mockMCPTools.executeTool
        .mockResolvedValueOnce(mockResult1)
        .mockResolvedValueOnce(mockResult2);

      const callHandler = toolHandlers.get(CallToolRequestSchema);
      const response = await callHandler!({
        params: {
          name: 'netsuite_run_parallel_queries',
          arguments: {
            queries: ['SELECT 1', 'SELECT 2']
          }
        }
      });

      const result = JSON.parse(response.content[0].text);
      expect(result.totalQueries).toBe(2);
      expect(result.successfulQueries).toBe(2);
      expect(result.failedQueries).toBe(0);
      expect(result.individualResults[0].result).toEqual({ data: [1] });
      expect(result.individualResults[1].result).toEqual({ data: [2] });
    });

    it('should generate NetSuite deep links and append to record actions', async () => {
      mockMCPTools.executeTool.mockResolvedValue({ id: 100, type: 'customer' });
      const callHandler = toolHandlers.get(CallToolRequestSchema);
      
      const response = await callHandler!({
        params: {
          name: 'ns_getRecord',
          arguments: { recordType: 'customer', id: '100' }
        }
      });

      expect(response.content[0].text).toContain('🔗 **NetSuite UI Link (Current Environment):**');
      expect(response.content[0].text).toContain('https://test-account.app.netsuite.com/app/common/entity/custjob.nl?id=100');
    });
  });
});
