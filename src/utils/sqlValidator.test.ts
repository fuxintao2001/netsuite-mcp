import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { parseTableAliases, getValidFieldsFromMetadata, validateQueryFields } from './sqlValidator.js';
import { cacheService } from './cache.js';

describe('SQL Validator', () => {
  const accountId = 'test-account';
  let getSpy: any;

  beforeEach(() => {
    getSpy = jest.spyOn(cacheService, 'get') as any;
  });

  afterEach(() => {
    getSpy.mockRestore();
  });

  describe('parseTableAliases', () => {
    it('should extract simple table names and aliases', () => {
      const sql = 'SELECT * FROM transaction t JOIN customer c ON t.entity = c.id';
      const aliasMap = parseTableAliases(sql);
      
      expect(aliasMap.get('t')).toBe('transaction');
      expect(aliasMap.get('c')).toBe('customer');
      expect(aliasMap.get('transaction')).toBe('transaction');
      expect(aliasMap.get('customer')).toBe('customer');
    });

    it('should ignore SQL keywords as aliases', () => {
      const sql = 'SELECT * FROM subsidiary WHERE id = 1';
      const aliasMap = parseTableAliases(sql);
      
      expect(aliasMap.get('subsidiary')).toBe('subsidiary');
      expect(aliasMap.get('where')).toBeUndefined();
    });
  });

  describe('getValidFieldsFromMetadata', () => {
    it('should extract properties from REST record type metadata', () => {
      const metadata = {
        properties: {
          entityid: { type: 'string' },
          companyname: { type: 'string' }
        }
      };
      const fields = getValidFieldsFromMetadata(metadata);
      expect(fields.has('entityid')).toBe(true);
      expect(fields.has('companyname')).toBe(true);
      expect(fields.has('id')).toBe(true); // default virtual
      expect(fields.has('rownum')).toBe(true); // default virtual
    });

    it('should extract columns from SuiteQL metadata', () => {
      const metadata = {
        name: 'subsidiary',
        columns: [
          { name: 'id', type: 'INTEGER' },
          { name: 'name', type: 'VARCHAR' }
        ]
      };
      const fields = getValidFieldsFromMetadata(metadata);
      expect(fields.has('id')).toBe(true);
      expect(fields.has('name')).toBe(true);
      expect(fields.has('entityid')).toBe(false);
    });
  });

  describe('validateQueryFields', () => {
    it('should pass if no cached metadata is found (graceful fallback)', async () => {
      getSpy.mockResolvedValue(null);
      const sql = 'SELECT invalid_field FROM unknown_table';
      const result = await validateQueryFields(sql, accountId);
      expect(result).toBeNull();
    });

    it('should pass on valid aliased fields', async () => {
      const mockMeta = {
        properties: {
          entityid: { type: 'string' }
        }
      };
      getSpy.mockResolvedValue(mockMeta);

      const sql = 'SELECT c.entityid FROM customer c';
      const result = await validateQueryFields(sql, accountId);
      expect(result).toBeNull();
    });

    it('should fail on invalid aliased fields', async () => {
      const mockMeta = {
        properties: {
          entityid: { type: 'string' }
        }
      };
      getSpy.mockImplementation((acc: string, key: string) => {
        if (key === 'ns_getRecordTypeMetadata_customer') return Promise.resolve(mockMeta);
        return Promise.resolve(null);
      });

      const sql = 'SELECT c.wrong_field FROM customer c';
      const result = await validateQueryFields(sql, accountId);
      expect(result).toContain("Field 'wrong_field' does not exist on table 'customer'");
    });

    it('should pass on valid un-aliased fields', async () => {
      const mockMeta = {
        columns: [
          { name: 'id' },
          { name: 'name' }
        ]
      };
      getSpy.mockResolvedValue(mockMeta);

      const sql = 'SELECT id, name FROM subsidiary WHERE id = 1';
      const result = await validateQueryFields(sql, accountId);
      expect(result).toBeNull();
    });

    it('should fail on invalid un-aliased fields', async () => {
      const mockMeta = {
        columns: [
          { name: 'id' },
          { name: 'name' }
        ]
      };
      getSpy.mockImplementation((acc: string, key: string) => {
        if (key.includes('subsidiary')) return Promise.resolve(mockMeta);
        return Promise.resolve(null);
      });

      const sql = 'SELECT id, wrong_field FROM subsidiary';
      const result = await validateQueryFields(sql, accountId);
      expect(result).toContain("Field 'wrong_field' does not exist in the queried tables: [subsidiary]");
    });

    it('should ignore SQL keywords, functions, and standard literals', async () => {
      const mockMeta = {
        columns: [
          { name: 'id' },
          { name: 'email' }
        ]
      };
      getSpy.mockResolvedValue(mockMeta);

      const sql = "SELECT id, BUILTIN.DF(id) as display, COUNT(1) FROM customer WHERE email = 'test@example.com' AND rownum <= 10";
      const result = await validateQueryFields(sql, accountId);
      expect(result).toBeNull();
    });

    it('should ignore words inside comments and multiple string literals', async () => {
      const mockMeta = {
        columns: [
          { name: 'id' },
          { name: 'name' }
        ]
      };
      getSpy.mockResolvedValue(mockMeta);

      const sql = `
        -- This is a comment containing wrong_field
        SELECT id, name /* another comment with bad_col */
        FROM subsidiary
        WHERE name = 'some string with bad_val' OR name = 'another val'
      `;
      const result = await validateQueryFields(sql, accountId);
      expect(result).toBeNull();
    });

    it('should fall back to RegExp validator if AST parser fails', async () => {
      const mockMeta = {
        columns: [
          { name: 'id' },
          { name: 'name' }
        ]
      };
      getSpy.mockImplementation((acc: string, key: string) => {
        if (key.includes('subsidiary')) return Promise.resolve(mockMeta);
        return Promise.resolve(null);
      });

      // A query with proprietary NetSuite outer join syntax that fails AST parsing
      const sql = 'SELECT id, wrong_field FROM subsidiary WHERE id (+) = 1';
      
      const result = await validateQueryFields(sql, accountId);
      expect(result).toContain("Field 'wrong_field' does not exist in the queried tables: [subsidiary]");
    });
  });
});
