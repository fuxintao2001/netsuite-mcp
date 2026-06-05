import { NetSuiteMCPTools } from './tools.js';
import { cacheService } from '../utils/cache.js';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import axios from 'axios';

describe('NetSuiteMCPTools', () => {
  let mockOAuthManager: any;
  let toolsClient: NetSuiteMCPTools;
  let globalAxiosPostSpy: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockOAuthManager = {
      getAccountId: jest.fn().mockResolvedValue('test-account'),
      ensureValidToken: jest.fn().mockResolvedValue('test-token')
    };

    // Pre-emptively mock axios.post globally to intercept constructor background calls
    globalAxiosPostSpy = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        result: {
          records: [],
          tools: []
        }
      }
    } as any);

    toolsClient = new NetSuiteMCPTools(mockOAuthManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getMCPEndpoint', () => {
    it('should return correct endpoint using account ID', async () => {
      const endpoint = await toolsClient.getMCPEndpoint();
      expect(endpoint).toBe('https://test-account.suitetalk.api.netsuite.com/services/mcp/v1/all');
    });

    it('should throw if account ID is missing', async () => {
      mockOAuthManager.getAccountId.mockResolvedValueOnce(null);
      await expect(toolsClient.getMCPEndpoint()).rejects.toThrow('Account ID not found. Please authenticate first.');
    });
  });

  describe('fetchTools', () => {
    it('should return cached tools if available', async () => {
      const mockTools = [{ name: 'ns_getRecord', description: 'Get a record' }];
      jest.spyOn(cacheService, 'get').mockResolvedValueOnce(mockTools);

      const result = await toolsClient.fetchTools();
      expect(result).toEqual(mockTools);
      expect(cacheService.get).toHaveBeenCalledWith('test-account', 'toolsCache');
    });

    it('should fetch tools from endpoint if cache is empty', async () => {
      jest.spyOn(cacheService, 'get').mockResolvedValueOnce(null);
      const mockApiResponse = {
        data: {
          result: {
            tools: [{ name: 'ns_getRecord', description: 'Get a record' }]
          }
        }
      };
      
      // Override global spy for this specific call
      globalAxiosPostSpy.mockResolvedValueOnce(mockApiResponse as any);
      const cacheSetSpy = jest.spyOn(cacheService, 'set').mockResolvedValueOnce(undefined);

      const result = await toolsClient.fetchTools();
      expect(result).toEqual(mockApiResponse.data.result.tools);
      expect(globalAxiosPostSpy).toHaveBeenCalled();
      expect(cacheSetSpy).toHaveBeenCalledWith('test-account', 'toolsCache', mockApiResponse.data.result.tools, 3600);
    });
  });

  describe('executeTool', () => {
    it('should return cached metadata for metadata tools if available', async () => {
      const cachedMetadata = { fields: [] };
      jest.spyOn(cacheService, 'get').mockResolvedValueOnce(cachedMetadata);

      const result = await toolsClient.executeTool('ns_getSuiteQLMetadata', { recordType: 'customer' });
      expect(result).toEqual(cachedMetadata);
      expect(cacheService.get).toHaveBeenCalledWith('test-account', 'ns_getSuiteQLMetadata_customer');
    });

    it('should execute tool and cache metadata upon successful response', async () => {
      jest.spyOn(cacheService, 'get').mockResolvedValueOnce(null);
      const mockResponse = {
        data: {
          result: { success: true }
        }
      };
      globalAxiosPostSpy.mockResolvedValueOnce(mockResponse as any);
      const cacheSetSpy = jest.spyOn(cacheService, 'set').mockResolvedValueOnce(undefined);

      const result = await toolsClient.executeTool('ns_getSuiteQLMetadata', { recordType: 'customer' });
      expect(result).toEqual(mockResponse.data.result);
      expect(globalAxiosPostSpy).toHaveBeenCalled();
      expect(cacheSetSpy).toHaveBeenCalledWith('test-account', 'ns_getSuiteQLMetadata_customer', mockResponse.data.result);
    });

    it('should trigger self-healing cache invalidation on SuiteQL error', async () => {
      jest.spyOn(cacheService, 'get').mockResolvedValueOnce(null);
      const mockError = new Error('Request failed with status code 500');
      Object.assign(mockError, {
        response: {
          status: 500,
          data: { error: 'invalid SuiteQL query' }
        }
      });
      
      globalAxiosPostSpy.mockRejectedValueOnce(mockError as any);
      const deleteSpy = jest.spyOn(cacheService, 'delete').mockResolvedValue(undefined as any);

      await expect(
        toolsClient.executeTool('ns_runCustomSuiteQL', { sqlQuery: 'SELECT * FROM invalid' })
      ).rejects.toThrow('Tool execution failed: Request failed with status code 500');

      // Verify selective cache invalidation was triggered for the 'invalid' table
      expect(deleteSpy).toHaveBeenCalledWith('test-account', 'ns_getSuiteQLMetadata_invalid');
      expect(deleteSpy).toHaveBeenCalledWith('test-account', 'ns_getRecordTypeMetadata_invalid');
    });



  describe('fetchCustomRecordMappings', () => {
    it('should resolve and cache custom record mappings from customrecordtype query', async () => {
      const mockSqlResult = {
        content: [{
          text: JSON.stringify({
            records: [
              { scriptid: 'customrecord_my_custom', internalid: '10' }
            ]
          })
        }]
      };
      
      // Stub executeTool for internal call
      jest.spyOn(toolsClient, 'executeTool').mockResolvedValueOnce(mockSqlResult);
      const cacheSetSpy = jest.spyOn(cacheService, 'set').mockResolvedValueOnce(undefined);

      // Force fetch
      toolsClient.hasFetchedMappings = false;
      await toolsClient.fetchCustomRecordMappings();

      expect(toolsClient.customRecordMappings.get('CUSTOMRECORD_MY_CUSTOM')).toBe(10);
      expect(cacheSetSpy).toHaveBeenCalledWith('test-account', 'customrecord_mappings', {
        'CUSTOMRECORD_MY_CUSTOM': 10
      });
    });
  });
});
