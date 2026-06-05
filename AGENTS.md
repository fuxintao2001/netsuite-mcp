# NetSuite MCP Server — AI Developer Guide

This repository contains the source code for the **NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`). It exposes NetSuite functionalities to AI agents over the Model Context Protocol (MCP).

## 🚀 Architecture Overview

- **Language & Runtime:** TypeScript (strict mode) on Node.js ≥ 18 (ESM).
- **Compilation:** Source in `src/` → compiled to `dist/` via `tsc`.
- **Transport:** Standard IO (`StdioServerTransport`). Entry point: `dist/index.js`.
- **Authentication:** OAuth 2.0 with PKCE (public client). No client secret needed.
- **Caching:** Dual-layer — L1 in-memory (`node-cache`, TTL 1h) + L2 file system (`.cache/`).

### Source Structure

```
src/
├── index.ts                   # Server bootstrap, handler wiring, and Zod env validation
├── handlers/
│   ├── tools.ts               # MCP tool registration + local tool handlers
│   ├── resources.ts           # MCP resource handlers (memory://sql-cheat-sheet)
│   └── prompts.ts             # MCP prompt handlers (netsuite-sql-expert)
├── mcp/
│   └── tools.ts               # NetSuite REST API client (read-only record & query execution)
├── oauth/
│   ├── manager.ts             # OAuth flow orchestrator
│   ├── callbackServer.ts      # Local HTTP callback for OAuth redirect
│   ├── tokenExchange.ts       # Token exchange & refresh logic
│   ├── sessionStorage.ts      # Session file I/O (types: SessionData, TokenData)
│   └── pkce.ts                # PKCE challenge/verifier generation
└── utils/
    ├── cache.ts               # CacheService singleton (L1 + L2)
    ├── envValidator.ts        # Startup environment configuration schema (Zod)
    ├── sqlValidator.ts        # SuiteQL AST (node-sql-parser) & RegExp spelling validator
    ├── resilience.ts          # retryWithBackoff, TokenRefreshScheduler
    ├── sqlMemory.ts           # Shared SQL memory template & file helpers
    ├── netsuiteUrls.ts        # NetSuite UI deep link URL generation
    └── browserLauncher.ts     # Cross-platform browser opener (secure execFile)
```

## ⚙️ Development Commands

| Command | Description |
|---|---|
| `npm run build` | Clean build (`rimraf dist && tsc`) |
| `npm test` | Run all Jest tests (47 tests / 7 suites) |
| `npm run start` | Start server (production, from `dist/`) |
| `npm run dev` | Start server (development, via `tsx`) |

## 🔧 Key Design Patterns

### Error Handling
- **MCP-facing errors** MUST use `McpError` + `ErrorCode` from `@modelcontextprotocol/sdk/types.js`:
  ```typescript
  import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
  throw new McpError(ErrorCode.InvalidRequest, 'Resource not found');
  throw new McpError(ErrorCode.InternalError, 'Failed to read file');
  throw new McpError(ErrorCode.MethodNotFound, 'Prompt not found');
  ```
- **Business/tool errors** return `{ isError: true }` via the `textResult()` helper:
  ```typescript
  return textResult('❌ Not authenticated.', true);
  ```
- **Never** throw raw `new Error()` from MCP request handlers.

### Tool Response Helper
All tool handlers use the `textResult()` helper to ensure `type: 'text'` is narrowed to the literal type required by the MCP SDK:
```typescript
function textResult(text: string, isError?: boolean): CallToolResult {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) };
}
```

### Dependency Injection
`registerToolHandlers()` accepts a single `ToolHandlerDeps` object:
```typescript
interface ToolHandlerDeps {
  server: Server;
  oauthManager: OAuthManager;
  mcpTools: NetSuiteMCPTools;
  projectRoot: string;
  handleAuthentication: (args) => Promise<ToolResponse>;
  handleLogout: () => Promise<ToolResponse>;
  handleCacheRefresh: () => Promise<ToolResponse>;
  resolveCustomRecordRectype: (type: string) => number | null;
}
```

- **Write Operations Disabled**: To ensure production database integrity and data accuracy, direct write operations (`ns_createRecord`, `ns_updateRecord`) are explicitly disabled at the handler level. Any attempts to write or update records will return an error.

### TypeScript Conventions
- `tsconfig.json` has `"strict": true` — all code must be fully typed.
- No `any` in public APIs. Use `unknown` + type narrowing or concrete interfaces.
- Tool names: `ns_` prefix for NetSuite-proxied tools, `netsuite_` prefix for local tools.

## 🧠 AI Agent Operating Procedures (SOP)

### 1. SuiteQL Queries (`ns_runCustomSuiteQL`)
- **SOP**: Always read the resource `memory://sql-cheat-sheet` BEFORE drafting any query. You can also invoke the Prompt `netsuite-sql-expert` to automatically inject this context.
- **Rule**: NEVER guess table schemas or column names. Call `ns_getSuiteQLMetadata` first.
- **Rule**: Only JOIN on fields explicitly marked with `x-n:joinable: true` in metadata.
- **Rule**: Prefer `BUILTIN.DF(field_name)` for display names over complex JOINs.
- **Rule**: Apply `ROWNUM` limits where appropriate to prevent timeouts, but be aware that query results are returned in full without silent auto-limiting to ensure calculation accuracy.
- **Rule**: If a query errors and you fix it, ALWAYS call `netsuite_save_sql_error` to document the correction.
- **🚨 PARALLEL RULE**: If you need to execute two or more SuiteQL queries (e.g. fetching related data, batch querying multiple tables, or retrieving multiple pages), you MUST use `netsuite_run_parallel_queries` to execute them concurrently instead of calling `ns_runCustomSuiteQL` sequentially. Sequential query execution is STRICTLY PROHIBITED unless a subsequent query depends on the output of a prior query.

### 2. NetSuite Record Operations (Read-Only)
- **SOP**: ALWAYS call `ns_getRecordTypeMetadata` before retrieving a record to verify its schema/properties.
- **Rule**: Write operations (`ns_createRecord`, `ns_updateRecord`) are strictly disabled. Do not attempt to call them.
- **Rule**: After successfully locating a record, use `netsuite_get_record_link` to generate a clickable UI URL.
- **Rule**: The `netsuite_get_record_slim` tool has been removed to ensure the AI always receives complete and accurate datasets. Always use `ns_getRecord` to fetch the full record.

### 3. Server Extensibility & Refactoring
- **Tools**: Add new side-effect operations to `src/handlers/tools.ts`. Extract each tool's logic into a standalone `async function handleXxx()`.
- **Resources**: Add new read-only endpoints to `src/handlers/resources.ts`. Use `McpError(ErrorCode.InvalidRequest, ...)` for unknown URIs.
- **Prompts**: Add new templated workflows to `src/handlers/prompts.ts`. List them in `ListPromptsRequestSchema` handler for client discovery.
- **Shared utilities**: Place reusable helpers in `src/utils/`. Use `src/utils/sqlMemory.ts` as the template pattern.
- **OAuth**: Token management is in `src/oauth/`. Session types are exported from `sessionStorage.ts`.

### 4. Caching
- `CacheService` is a singleton configured at startup via `cacheService.configure(projectRoot)`.
- Metadata cache auto-invalidates on SuiteQL errors (self-healing).
- Use `netsuite_refresh_cache` to force clear both L1/L2 and NetSuite REST session cache.

### 5. Authentication Lifecycle
- `fetchCustomRecordMappings()` is called AFTER successful authentication, not in constructor.
- `TokenRefreshScheduler` proactively refreshes tokens before expiry (every 10 min check).
- On `401` errors, tools auto-retry once after force-refreshing the access token.
