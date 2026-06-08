# SuiteQL Query & Syntax Reference Guide

This document serves as the official reference for writing SuiteQL queries in this project. SuiteQL is based on a subset of **Oracle SQL** syntax.

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
