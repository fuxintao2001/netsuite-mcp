import { registerToolHandlers } from './tools.js';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
      }),
      listRoots: jest.fn().mockResolvedValue({ roots: [] })
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
      const names = result.tools.map((t: any) => t.name);
      expect(names).toContain('ns_getRecord');
      expect(names).toContain('netsuite_get_record_link');
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

    it('should block write operations in production environments', async () => {
      mockOAuthManager.getAccountId.mockResolvedValue('123456');
      const callHandler = toolHandlers.get(CallToolRequestSchema);
      
      // McpError is thrown and should propagate
      await expect(callHandler!({
        params: {
          name: 'ns_createRecord',
          arguments: { recordType: 'customer', record: {} }
        }
      })).rejects.toThrow('Write operations are disabled in production environments');
    });

    it('should allow write operations in sandbox environments', async () => {
      mockOAuthManager.getAccountId.mockResolvedValue('123456_SB1');
      mockMCPTools.executeTool.mockResolvedValue({ id: 200, type: 'customer' });
      const callHandler = toolHandlers.get(CallToolRequestSchema);
      
      const response = await callHandler!({
        params: {
          name: 'ns_createRecord',
          arguments: { recordType: 'customer', record: {} }
        }
      });
      expect(response.content[0].text).toContain('🔗 **NetSuite UI Link (Current Environment):**');
    });

    it('should filter out write tools in production listing', async () => {
      mockMCPTools.fetchTools.mockResolvedValue([
        { name: 'ns_getRecord', description: 'Get' },
        { name: 'ns_createRecord', description: 'Create' },
        { name: 'ns_updateRecord', description: 'Update' }
      ]);
      const listHandler = toolHandlers.get(ListToolsRequestSchema);
      
      // Production: write tools filtered out
      mockOAuthManager.getAccountId.mockResolvedValue('123456');
      const prodResult = await listHandler!();
      const prodNames = prodResult.tools.map((t: any) => t.name);
      expect(prodNames).toContain('ns_getRecord');
      expect(prodNames).not.toContain('ns_createRecord');
      expect(prodNames).not.toContain('ns_updateRecord');
      
      // Sandbox: all tools included
      mockOAuthManager.getAccountId.mockResolvedValue('TSTDRV123456');
      const sbResult = await listHandler!();
      const sbNames = sbResult.tools.map((t: any) => t.name);
      expect(sbNames).toContain('ns_getRecord');
      expect(sbNames).toContain('ns_createRecord');
      expect(sbNames).toContain('ns_updateRecord');
    });

    it('should append parallel query warning to ns_runCustomSuiteQL description', async () => {
      mockMCPTools.fetchTools.mockResolvedValue([
        { name: 'ns_runCustomSuiteQL', description: 'Execute a custom SuiteQL query' }
      ]);
      const listHandler = toolHandlers.get(ListToolsRequestSchema);
      
      const result = await listHandler!();
      const customTool = result.tools.find((t: any) => t.name === 'ns_runCustomSuiteQL');
      expect(customTool).toBeDefined();
      expect(customTool.description).toContain('Execute a custom SuiteQL query');
      expect(customTool.description).toContain('netsuite_run_parallel_queries');
    });

    it('should hide all tools if workspace account mismatch', async () => {
      // Setup active workspace to target a different account
      mockServer.listRoots.mockResolvedValue({
        roots: [
          { uri: `file://${testWorkspace}`, name: 'test' }
        ]
      });

      // Write a project.json for a mismatching account
      await fs.writeFile(
        path.join(testWorkspace, 'project.json'),
        JSON.stringify({ defaultAuthId: 'different-account-Adm-Sand' })
      );

      mockOAuthManager.getAccountId.mockResolvedValue('my-account');

      const listHandler = toolHandlers.get(ListToolsRequestSchema);
      const result = await listHandler!();
      expect(result.tools).toEqual([]);
    });

    it('should show tools if workspace account matches', async () => {
      // Setup active workspace to target the matching account
      mockServer.listRoots.mockResolvedValue({
        roots: [
          { uri: `file://${testWorkspace}`, name: 'test' }
        ]
      });

      // Write a project.json for the matching account
      await fs.writeFile(
        path.join(testWorkspace, 'project.json'),
        JSON.stringify({ defaultAuthId: 'my-account-Adm-Sand' })
      );

      mockOAuthManager.getAccountId.mockResolvedValue('my-account');

      const listHandler = toolHandlers.get(ListToolsRequestSchema);
      const result = await listHandler!();
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('should fail tool call if workspace account mismatch', async () => {
      // Setup active workspace to target a different account
      mockServer.listRoots.mockResolvedValue({
        roots: [
          { uri: `file://${testWorkspace}`, name: 'test' }
        ]
      });

      // Write a project.json for a mismatching account
      await fs.writeFile(
        path.join(testWorkspace, 'project.json'),
        JSON.stringify({ defaultAuthId: 'different-account-Adm-Sand' })
      );

      mockOAuthManager.getAccountId.mockResolvedValue('my-account');

      const callHandler = toolHandlers.get(CallToolRequestSchema);
      await expect(callHandler!({
        params: {
          name: 'ns_getRecord',
          arguments: { recordType: 'customer', id: '100' }
        }
      })).rejects.toThrow('This tool is disabled because the active workspace does not match the NetSuite account');
    });

    it('should bypass workspace matching check if workspace is netsuite-mcp-server-master', async () => {
      // Setup active workspace to be netsuite-mcp-server-master
      mockServer.listRoots.mockResolvedValue({
        roots: [
          { uri: 'file:///Users/fuxintao/WebstormProjects/netsuite-mcp-server-master', name: 'netsuite-mcp-server-master' }
        ]
      });

      mockOAuthManager.getAccountId.mockResolvedValue('my-account');

      const listHandler = toolHandlers.get(ListToolsRequestSchema);
      const result = await listHandler!();
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('should require auth for parallel queries', async () => {
      mockOAuthManager.hasValidSession.mockResolvedValue(false);
      const callHandler = toolHandlers.get(CallToolRequestSchema);
      
      const response = await callHandler!({
        params: {
          name: 'netsuite_run_parallel_queries',
          arguments: { queries: ['SELECT 1'] }
        }
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Not authenticated');
    });
  });
});
