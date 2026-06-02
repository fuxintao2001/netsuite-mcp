# NetSuite MCP Server & Skills Toolkit AI Developer Guide

This repository contains the source code for the **NetSuite MCP Server**. It is designed to expose NetSuite functionalities to AI agents over the Model Context Protocol (MCP).

## 🚀 Architecture Overview
- **Language & Environment:** TypeScript on Node.js (ESM).
- **Compilation:** Source files in `src/` are compiled via `tsc` to `dist/`.
- **MCP Endpoints:** Uses Standard IO Transport. The primary entry point is `dist/index.js`.
- **Caching Mechanism:** Implements a dual-layer L1 (node-cache) and L2 (local file system in `.cache/`) strategy for metadata and record mapping cache.

## ⚙️ Development Commands
- **Compile / Build Project:** `npm run build`
- **Run Unit Tests:** `npm test`
- **Start MCP Server (Production):** `npm run start`
- **Start MCP Server (Development):** `npm run dev` (uses `tsx`)

## 🧠 AI Agent Operating Procedures (SOP)

### 1. SuiteQL Queries (`ns_runCustomSuiteQL`)
- **SOP**: Always read the local memory resource `memory://sql-cheat-sheet` BEFORE drafting any query. You can also run the Prompt `netsuite-sql-expert` to automatically inject this context.
- **Rule**: NEVER guess NetSuite table schemas or column names. You MUST call `ns_getSuiteQLMetadata` first.
- **Rule**: Only JOIN on fields explicitly marked with `x-n:joinable: true` in the metadata.
- **Rule**: Prioritize using `BUILTIN.DF(field_name)` to get display names instead of complex JOINS.
- **Rule**: Apply `ROWNUM <= 1000` to prevent query timeout issues.
- **Rule**: If a SuiteQL query errors and you fix it, ALWAYS document the correction using the `netsuite_save_sql_error` tool.

### 2. NetSuite Record Operations (CRUD)
- **SOP**: ALWAYS call `ns_getRecordTypeMetadata` before creating or updating a record to verify its exact JSON schema constraints.
- **Rule**: Provide arrays strictly conforming to the sublist metadata definitions.
- **Rule**: Keep all values strictly aligned with NetSuite internal mappings (e.g., IDs must be integers/strings as defined, checkboxes must be booleans).
- **Rule**: Upon successfully creating or locating a record, use `netsuite_get_record_link` to generate a clickable NetSuite UI URL for the user.

### 3. Server Extensibility & Refactoring
- **Rule**: Add new side-effect operations to `src/handlers/tools.ts`.
- **Rule**: Add new read-only / context endpoints to `src/handlers/resources.ts`.
- **Rule**: Add new templated workflows to `src/handlers/prompts.ts`.
