# SuiteQL Query & Syntax Reference Guide

This document serves as the official reference for writing SuiteQL queries in this project. SuiteQL is based on a subset of **Oracle SQL** syntax.

## 0. Official Documentation & Core Syntax Rules
For complete, authoritative Oracle NetSuite documentation on SuiteQL syntax, functions, and limitations, refer to the following official resources:

### Official Oracle Help Center SuiteQL Sections:
*   📖 **[SuiteQL Overview](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257770590.html)** — Core guide on leveraging SuiteQL in NetSuite.
*   ✏️ **[SuiteQL Syntax and Examples](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257791851.html)** — Syntax structure, parameters (`?`), joins, and subselection rules.
*   ✅ **[SuiteQL Supported and Unsupported Functions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257799794.html)** — Detailed list of standard SQL functions allowed in queries.
*   ⚙️ **[SuiteQL Supported Built-in Functions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257816823.html)** — Rules for NetSuite-specific built-in functions (e.g. `BUILTIN.DF`, `BUILTIN.CONSOLIDATE`).

### Metadata & Schema Discovery:
*   📊 **NetSuite Records Catalog**: Access via your NetSuite UI path: `/app/recordscatalog/rcanalytics.nl` (*Setup > Records Catalog*). This is the authoritative source for the **SuiteAnalytics Workbook / NetSuite2.com** schema used by SuiteQL.
*   🌐 **[NetSuite Records Browser](https://system.netsuite.com/help/helpcenter/en_US/sdo/sdo_index.html)** — Classic schema reference (note: SuiteQL uses NetSuite2.com analytics schema, which may differ slightly from the classic records browser).

### Core Rules from Official Docs:
*   **Preferred Syntax**: Always prefer **Oracle SQL syntax** over SQL-92. While ANSI SQL-92 is supported, it carries a higher risk of performance issues (such as timeouts) when converted internally.
*   **No Mixing**: You can use either SQL-92 or Oracle SQL syntax, but **you cannot mix them in the same query**.
*   **Case Sensitivity**: Table and column names in results may vary in casing depending on the NetSuite release version. Do not build business logic that relies on specific output casing.

---

## 1. Core SELECT & JOIN Syntax

### Explicit JOINs Only
Always use explicit `INNER JOIN`, `LEFT OUTER JOIN`, or `RIGHT OUTER JOIN`. Implicit comma joins (e.g. `FROM tableA, tableB`) are prohibited.
```sql
-- CORRECT
SELECT t.id, t.tranid, c.altname 
FROM transaction t 
INNER JOIN customer c ON t.entity = c.id 
WHERE t.type = 'SalesOrd'
```

### Table & Column Aliases
Always provide explicit aliases for subqueries and tables to avoid column name ambiguity.
```sql
-- CORRECT
SELECT sub.status, COUNT(sub.id) AS qty 
FROM (
  SELECT id, BUILTIN.DF(status) AS status FROM transaction WHERE type = 'SalesOrd'
) sub 
GROUP BY sub.status
```

---

## 2. Date & Time Functions (Oracle SQL Subset)

SuiteQL does not support string date literals directly. You must explicitly convert strings to dates.

### Date Conversion (`TO_DATE`)
Always wrap date filters in `TO_DATE` with the format mask `'YYYY-MM-DD'`.
```sql
-- CORRECT
SELECT id, trandate FROM transaction 
WHERE trandate >= TO_DATE('2024-01-01', 'YYYY-MM-DD')
```

### Date Formatting (`TO_CHAR`)
Format dates to string outputs.
```sql
SELECT TO_CHAR(trandate, 'YYYY-MM') AS month_period FROM transaction
```

### Date Arithmetic (`ADD_MONTHS`, `TRUNC`)
```sql
-- Find records in the last 3 months
SELECT id, trandate FROM transaction 
WHERE trandate >= ADD_MONTHS(TRUNC(SYSDATE), -3)
```

---

## 3. String Manipulation & Concatenation

### Concatenation (`||`)
Do NOT use `+` or `CONCAT()` for multiple strings. Use the `||` operator.
```sql
-- CORRECT
SELECT firstname || ' ' || lastname AS fullname FROM employee
```

### Substring & Length
```sql
SELECT SUBSTR(name, 1, 10) AS short_name, LENGTH(name) AS len FROM item
```

---

## 4. Null & Conditional Logic

### Null Handling (`NVL`, `COALESCE`)
Use `NVL(field, fallback)` to replace nulls.
```sql
SELECT id, NVL(memo, 'No memo provided') AS memo_clean FROM transaction
```

### Conditional Logic (`CASE WHEN`, `DECODE`)
Use `CASE WHEN` for multi-condition evaluations.
```sql
SELECT id, 
       CASE WHEN foreignamount > 10000 THEN 'High Value'
            WHEN foreignamount > 1000  THEN 'Medium Value'
            ELSE 'Low Value'
       END AS value_tier
FROM transaction
```

---

## 5. NetSuite BUILTIN Functions

All NetSuite-specific functions must be prefixed with `BUILTIN.`.

### Display Value (`BUILTIN.DF`)
Retrieves the text display representation of an enum, status, or foreign key relationship, saving expensive joins.
```sql
-- Gets the actual status name (e.g. "Pending Approval") rather than the internal code (e.g. "A")
SELECT id, BUILTIN.DF(status) AS status_display FROM transaction
```

### Currency Consolidation (`BUILTIN.CONSOLIDATE`)
Converts transaction amounts to consolidated subsidiary currency.
```sql
-- Parameters: (field, type, currencyId, trandate)
-- type options: 'A' (Average), 'H' (Historical), 'C' (Current)
SELECT id, BUILTIN.CONSOLIDATE(foreignamount, 'A', 1, trandate) AS consolidated_usd FROM transaction
```

---

## 6. Common Pitfalls & Anti-Patterns

### ❌ Prohibited MySQL/PostgreSQL Syntax
*   `LIMIT 10` -> **Use `FETCH FIRST 10 ROWS ONLY` instead.**
*   `ILIKE` -> **Use `LOWER(field) LIKE LOWER('%query%')` instead.**
*   `::varchar` or `CAST(x AS type)` -> **Use `TO_CHAR(x)` or `TO_NUMBER(x)` instead.**
*   `WITH cte_name AS (...)` -> **SuiteQL does not support CTEs. Use subqueries.**
*   `Square brackets []` -> **Do not surround table or field names in brackets.**

### ⚠️ Transaction Mainline Filter
When querying `transaction` and `transactionline`, always filter by `mainline` to get accurate results:
*   `mainline = 'T'` (Summary/Header row of the transaction).
*   `mainline = 'F'` (Line items of the transaction).
```sql
-- Querying only transaction header details
SELECT id, tranid FROM transaction WHERE mainline = 'T' AND type = 'SalesOrd'
```

---

## 7. Script Execution Log Queries (ScriptNote)

NetSuite script execution logs are stored in the `ScriptNote` table. This is the primary way to query script logs via SuiteQL.

### Basic Log Query
```sql
SELECT 
    ScriptNote.date,
    ScriptNote.type,
    ScriptNote.title AS log_title,
    ScriptNote.detail
FROM ScriptNote
ORDER BY ScriptNote.date DESC
FETCH FIRST 100 ROWS ONLY
```

### Query Logs with Script Name (JOIN Script)
```sql
SELECT 
    ScriptNote.date,
    ScriptNote.type,
    ScriptNote.title AS log_title,
    ScriptNote.detail,
    Script.name AS script_name
FROM ScriptNote
INNER JOIN Script ON ScriptNote.scriptType = Script.id
ORDER BY ScriptNote.date DESC
FETCH FIRST 100 ROWS ONLY
```

### Query Logs with Deployment Info (JOIN ScriptDeployment)
```sql
SELECT 
    log.date,
    log.type,
    scriptDeployment.title AS deployment_title,
    log.title AS log_title,
    log.detail,
    scriptDeployment.scriptid AS deployment_id
FROM ScriptNote AS log
INNER JOIN scriptDeployment ON log.scriptType = scriptDeployment.script
ORDER BY log.date DESC
FETCH FIRST 100 ROWS ONLY
```

### Filter by Script ID
```sql
SELECT 
    ScriptNote.date,
    ScriptNote.type,
    ScriptNote.title AS log_title,
    ScriptNote.detail
FROM ScriptNote
INNER JOIN Script ON ScriptNote.scriptType = Script.id
WHERE Script.scriptid = 'customscript_my_script'
ORDER BY ScriptNote.date DESC
FETCH FIRST 50 ROWS ONLY
```

### Filter by Log Type (ERROR / DEBUG / AUDIT / EMERGENCY)
```sql
SELECT 
    ScriptNote.date,
    ScriptNote.title AS log_title,
    ScriptNote.detail,
    Script.name AS script_name
FROM ScriptNote
INNER JOIN Script ON ScriptNote.scriptType = Script.id
WHERE ScriptNote.type = 'ERROR'
ORDER BY ScriptNote.date DESC
FETCH FIRST 50 ROWS ONLY
```

### ⚠️ Important Notes
- **Log Retention**: Script logs are retained for approximately **30 days** and are subject to storage limits.
- **Permissions**: Administrator role or equivalent permissions are required to query `ScriptNote`.
- **Performance**: Always include `FETCH FIRST N ROWS ONLY` to avoid pulling excessive log data.
- **Long-term Storage**: If you need logs beyond 30 days, consider writing to custom records in your SuiteScript.
