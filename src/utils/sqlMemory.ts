import fs from 'fs/promises';

/**
 * Default template for the SuiteQL memory file.
 * Shared between resources handler (read) and tools handler (save_sql_error).
 */
export const DEFAULT_SQL_MEMORY_TEMPLATE =
  `# Gemini SuiteQL Memory & Lessons Learned\n\n` +
  `> [!IMPORTANT]\n` +
  `> Before writing or modifying any SuiteQL, you MUST read this file and strictly follow the verified rules below to avoid repeating mistakes.\n\n` +
  `## NetSuite SuiteQL Core Rules\n` +
  `1. **[NO GUESSING]** Absolutely never guess NetSuite table or field names based on experience.\n` +
  `2. **[SCHEMA FIRST]** Before writing any query, you must call \`ns_getSuiteQLMetadata\` to retrieve the actual field definitions of the relevant Record type.\n` +
  `3. **[VERIFY JOINS]** Only use a field for JOINs if it is explicitly marked with \`x-n:joinable: true\` in the metadata.\n` +
  `4. **[USE BUILTIN]** Prioritize using the \`BUILTIN.DF(field)\` function to get the display text of related fields, avoiding complex and error-prone JOIN logic.\n` +
  `5. **[CLOSED LOOP]** If a SQL execution error occurs during development, analyze the error, re-verify the Schema, and once resolved, ALWAYS document the correction using the \`netsuite_save_sql_error\` tool.\n\n` +
  `## Historical Errors & Correct Examples (Verified Rules)\n`;

/**
 * Read the SQL memory file, creating it with the default template if it doesn't exist.
 */
export async function readOrCreateSqlMemory(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') throw err;
    await fs.writeFile(filePath, DEFAULT_SQL_MEMORY_TEMPLATE, 'utf-8');
    return DEFAULT_SQL_MEMORY_TEMPLATE;
  }
}
