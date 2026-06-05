import { cacheService } from './cache.js';
import pkg from 'node-sql-parser';
const { Parser } = pkg;

const parser = new Parser();

/**
 * Helper to recursively traverse the AST and run a callback on each node.
 */
function walkAST(node: any, callback: (n: any) => void) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        walkAST(item, callback);
      }
    } else {
      walkAST(value, callback);
    }
  }
}

/**
 * Parses all table aliases from a SuiteQL query using RegExp.
 * Used as a fallback if the AST parser fails.
 */
export function parseTableAliasesRegExp(sqlQuery: string): Map<string, string> {
  const aliasMap = new Map<string, string>(); // alias -> tableName
  const normalized = sqlQuery.toLowerCase();
  
  const tableRegex = /\b(?:from|join)\s+([a-zA-Z0-9_-]+)(?:\s+(?:as\s+)?([a-zA-Z0-9_-]+))?\b/gi;
  let match;
  
  while ((match = tableRegex.exec(normalized)) !== null) {
    const tableName = match[1];
    const alias = match[2];
    
    if (alias) {
      const keywords = ['where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'union', 'group', 'order', 'limit', 'and', 'or'];
      if (!keywords.includes(alias)) {
        aliasMap.set(alias, tableName);
      }
    }
    aliasMap.set(tableName, tableName);
  }
  
  return aliasMap;
}

/**
 * Parses all table aliases from a SuiteQL query.
 * First tries AST parsing (recursively), falling back to RegExp parsing if it fails.
 */
export function parseTableAliases(sqlQuery: string): Map<string, string> {
  const cleanedQuery = sqlQuery
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ');

  try {
    const ast = parser.astify(sqlQuery);
    const astArray = Array.isArray(ast) ? ast : [ast];
    const aliasMap = new Map<string, string>();
    
    for (const statement of astArray) {
      walkAST(statement, (node) => {
        if (node && typeof node.table === 'string' && node.type !== 'column_ref') {
          const tableName = node.table;
          const alias = typeof node.as === 'string' ? node.as : null;
          if (alias) {
            aliasMap.set(alias.toLowerCase(), tableName);
          }
          aliasMap.set(tableName.toLowerCase(), tableName);
        }
      });
    }
    if (aliasMap.size > 0) {
      return aliasMap;
    }
  } catch (err) {
    // Fallback to RegExp
  }
  
  return parseTableAliasesRegExp(cleanedQuery);
}

/**
 * Extracts a normalized Set of lowercase valid field names from cached metadata.
 * Supports both REST record type schemas and SuiteQL metadata schemas.
 */
export function getValidFieldsFromMetadata(metadata: any): Set<string> {
  const fields = new Set<string>();
  if (!metadata) return fields;

  let schema = metadata;

  // 1. Handle MCP CallToolResult wrapper structure
  if (metadata.content && Array.isArray(metadata.content) && metadata.content[0] && typeof metadata.content[0].text === 'string') {
    try {
      schema = JSON.parse(metadata.content[0].text);
    } catch {
      // Ignore
    }
  }

  // 2. Handle success/metadata wrapper structure
  if (schema.success && schema.metadata && typeof schema.metadata === 'object') {
    schema = schema.metadata;
  } else if (schema.metadata && typeof schema.metadata === 'object') {
    schema = schema.metadata;
  }

  if (schema.properties && typeof schema.properties === 'object') {
    for (const key of Object.keys(schema.properties)) {
      fields.add(key.toLowerCase());
    }
  }
  
  if (Array.isArray(schema.columns)) {
    for (const col of schema.columns) {
      if (col && typeof col.name === 'string') {
        fields.add(col.name.toLowerCase());
      }
    }
  }

  fields.add('id');
  fields.add('rownum');

  return fields;
}

/**
 * Performs local validation on a SuiteQL query using RegExp.
 * Used as a fallback if the AST parser fails.
 */
export async function validateQueryFieldsRegExp(
  cleanedQuery: string,
  accountId: string
): Promise<string | null> {
  const aliasMap = parseTableAliasesRegExp(cleanedQuery);
  if (aliasMap.size === 0) return null;

  const tableMetadataMap = new Map<string, Set<string>>();
  
  for (const tableName of new Set(aliasMap.values())) {
    const cacheKey1 = `ns_getRecordTypeMetadata_${tableName}`;
    const cacheKey2 = `ns_getSuiteQLMetadata_${tableName}`;
    
    let metadata = await cacheService.get(accountId, cacheKey2);
    if (!metadata) {
      metadata = await cacheService.get(accountId, cacheKey1);
    }
    
    if (metadata) {
      const validFields = getValidFieldsFromMetadata(metadata);
      tableMetadataMap.set(tableName, validFields);
    }
  }

  if (tableMetadataMap.size === 0) return null;

  const aliasedFieldRegex = /\b([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\b/g;
  let match;
  aliasedFieldRegex.lastIndex = 0;
  
  while ((match = aliasedFieldRegex.exec(cleanedQuery)) !== null) {
    const alias = match[1].toLowerCase();
    const fieldName = match[2].toLowerCase();
    
    if (alias === 'builtin' && fieldName === 'df') continue;

    const tableName = aliasMap.get(alias);
    if (tableName) {
      const validFields = tableMetadataMap.get(tableName);
      if (validFields && !validFields.has(fieldName)) {
        if (/^\d+$/.test(fieldName)) continue;
        return `Local Validation Error: Field '${fieldName}' does not exist on table '${tableName}'.`;
      }
    }
  }

  const aliasRegex = /\bas\s+([a-zA-Z0-9_]+)\b/gi;
  let aliasMatch;
  const columnAliases = new Set<string>();
  while ((aliasMatch = aliasRegex.exec(cleanedQuery)) !== null) {
    columnAliases.add(aliasMatch[1].toLowerCase());
  }

  const words = cleanedQuery.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
  const SQL_KEYWORDS = new Set([
    'select', 'from', 'where', 'and', 'or', 'join', 'on', 'as', 'order', 'by', 
    'desc', 'asc', 'null', 'rownum', 'builtin', 'df', 'to_date', 'to_char', 
    'nvl', 'coalesce', 'sum', 'count', 'max', 'min', 'avg', 'group', 'having', 
    'left', 'right', 'inner', 'outer', 'in', 'between', 'like', 'is', 'not',
    'exists', 'all', 'any', 'some', 'distinct', 'into', 'insert',
    'update', 'delete', 'create', 'table', 'drop', 'alter', 'index', 'view'
  ]);

  for (const word of words) {
    const wordLower = word.toLowerCase();
    
    if (SQL_KEYWORDS.has(wordLower)) continue;
    if (aliasMap.has(wordLower)) continue;
    if (Array.from(aliasMap.values()).includes(wordLower)) continue;
    if (columnAliases.has(wordLower)) continue;
    
    const aliasDotRegex = new RegExp(`\\b${word}\\s*\\.`, 'i');
    if (aliasDotRegex.test(cleanedQuery)) continue;

    const funcRegex = new RegExp(`\\b${word}\\s*\\(`, 'i');
    if (funcRegex.test(cleanedQuery)) continue;

    let foundInAnyTable = false;
    let hasMetadataForAtLeastOneTable = false;

    for (const tableName of new Set(aliasMap.values())) {
      const validFields = tableMetadataMap.get(tableName);
      if (validFields) {
        hasMetadataForAtLeastOneTable = true;
        if (validFields.has(wordLower)) {
          foundInAnyTable = true;
          break;
        }
      }
    }

    if (hasMetadataForAtLeastOneTable && !foundInAnyTable) {
      return `Local Validation Error: Field '${word}' does not exist in the queried tables: [${Array.from(new Set(aliasMap.values())).join(', ')}].`;
    }
  }

  return null;
}

/**
 * Performs local validation on a SuiteQL query.
 * First tries AST-based validation, falling back to RegExp if it fails or parser error occurs.
 *
 * @returns Error message string if a spelling error is detected, otherwise null.
 */
export async function validateQueryFields(
  sqlQuery: string,
  accountId: string
): Promise<string | null> {
  const cleanedQuery = sqlQuery
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ');

  try {
    const ast = parser.astify(sqlQuery);
    const astArray = Array.isArray(ast) ? ast : [ast];
    
    const aliasMap = parseTableAliases(sqlQuery);
    if (aliasMap.size === 0) return null;

    const tableMetadataMap = new Map<string, Set<string>>();
    for (const tableName of new Set(aliasMap.values())) {
      const cacheKey1 = `ns_getRecordTypeMetadata_${tableName}`;
      const cacheKey2 = `ns_getSuiteQLMetadata_${tableName}`;
      
      let metadata = await cacheService.get(accountId, cacheKey2);
      if (!metadata) {
        metadata = await cacheService.get(accountId, cacheKey1);
      }
      
      if (metadata) {
        const validFields = getValidFieldsFromMetadata(metadata);
        tableMetadataMap.set(tableName, validFields);
      }
    }

    if (tableMetadataMap.size === 0) return null;

    const columnRefs: Array<{ table: string | null; column: string }> = [];
    const columnAliases = new Set<string>();

    for (const statement of astArray) {
      walkAST(statement, (node) => {
        if (node.type === 'column_ref' && typeof node.column === 'string') {
          columnRefs.push({
            table: typeof node.table === 'string' ? node.table : null,
            column: node.column
          });
        }
        if (node.expr && typeof node.as === 'string') {
          columnAliases.add(node.as.toLowerCase());
        }
      });
    }

    for (const ref of columnRefs) {
      const colLower = ref.column.toLowerCase();

      if (colLower === 'rownum' || colLower === 'id' || colLower === '*' || columnAliases.has(colLower)) continue;

      if (ref.table) {
        const aliasLower = ref.table.toLowerCase();
        if (aliasLower === 'builtin') continue;

        const tableName = aliasMap.get(aliasLower);
        if (tableName) {
          const validFields = tableMetadataMap.get(tableName);
          if (validFields && !validFields.has(colLower)) {
            if (/^\d+$/.test(colLower)) continue;
            return `Local Validation Error: Field '${ref.column}' does not exist on table '${tableName}'.`;
          }
        }
      } else {
        let foundInAnyTable = false;
        let hasMetadataForAtLeastOneTable = false;

        for (const tableName of new Set(aliasMap.values())) {
          const validFields = tableMetadataMap.get(tableName);
          if (validFields) {
            hasMetadataForAtLeastOneTable = true;
            if (validFields.has(colLower)) {
              foundInAnyTable = true;
              break;
            }
          }
        }

        if (hasMetadataForAtLeastOneTable && !foundInAnyTable) {
          return `Local Validation Error: Field '${ref.column}' does not exist in the queried tables: [${Array.from(new Set(aliasMap.values())).join(', ')}].`;
        }
      }
    }

    return null;
  } catch (astErr) {
    console.error('⚠️ SQL AST parser failed to parse query. Falling back to RegExp parser.');
    return validateQueryFieldsRegExp(cleanedQuery, accountId);
  }
}
