# NetSuite MCP Server

A Model Context Protocol (MCP) server providing access to NetSuite data through OAuth 2.0 with PKCE authentication. Works seamlessly with any MCP-compatible client including Claude Code, Cursor IDE, and Gemini CLI.

# Motivation and Context
NetSuite provides an official AI Connector SuiteApp that enables AI-powered interactions with NetSuite data. However, NetSuite's AI Connector currently only supports:

- Claude via Anthropic's web interface
- ChatGPT via custom GPT connections
The problem: Developers using MCP-compatible tools like Claude Code, Cursor IDE, Windsurf, or other CLI/IDE environments cannot leverage NetSuite's AI capabilities
because there's no MCP server implementation.

This MCP server solves that gap by:

- Providing the missing bridge between MCP clients (Claude Code, Cursor, Gemini CLI, etc.) and NetSuite's AI Connector
- Enabling the exact same functionality that NetSuite's AI Connector provides, but accessible through any MCP-compatible client
- Allowing developers to interact with NetSuite data using natural language directly within their development environment
- Maintaining the same security standards (OAuth 2.0 with PKCE) required by NetSuite's official AI Connector
  
In essence, this MCP server brings NetSuite's AI capabilities to the broader MCP ecosystem, allowing developers to query business data, generate reports, and automate
NetSuite operations without leaving their IDE or CLI.

## Features

- ✅ **OAuth 2.0 with PKCE** - Secure authentication without client secrets
- ✅ **Automatic & Concurrency-Safe Token Refresh** - Tokens refresh automatically before expiration; concurrent API requests share a single refresh promise to prevent duplicate token exchange calls
- ✅ **Environment Variable Support** - Configure credentials once in your MCP config
- ✅ **Session Persistence** - Authentication survives server restarts
- ✅ **Universal MCP Integration** - Works with Claude Code, Cursor IDE, Gemini CLI, and other MCP clients
- ✅ **NetSuite MCP Tools** - Access to all NetSuite MCP capabilities (SuiteQL, Reports, Records, etc.)
- ✅ **Modular Architecture** - Clean TypeScript codebase following single-responsibility principle
- 🚀 **Real-time Data Cache Refresh** - Dedicated tool to trigger NetSuite REST session cache reload
- 🔒 **Multi-Environment Isolation & Workspace Matching** - Run multiple sandbox/production accounts concurrently. Automatic workspace verification warns and disables business tools on mismatch to prevent cross-account accidents
- 🛡️ **Production Safety** - Write operations (`ns_createRecord`, `ns_updateRecord`) are automatically disabled in production environments
- 🩺 **Diagnostic Status Tool** - Built-in status check for authentication state, environment details, and cache statistics

## Quick Start

### 1. NetSuite Setup

#### Step 1: Install NetSuite AI Connector SuiteApp

Before creating the integration record, you must install and configure the NetSuite AI Connector SuiteApp.

**Important**: The NetSuite AI Connector SuiteApp is required for MCP functionality. Without it, the MCP tools will not be available even after authentication.

#### Step 2: Create OAuth Integration Record

After installing the SuiteApp, create an integration record:

1. Navigate to **Setup > Integration > Manage Integrations > New**
2. Fill in the details:
   - **Name**: "MCP Server Integration"
   - **OAuth 2.0**: Checked Authorization Code Grant
                    Checked Public Client
   - **Redirect URI**: `http://localhost:8080/callback` (or your custom port)
3. Save and copy the **Client ID** (consumer key)

**Note**: We don't need client secret (since this is a public client with Authorization Code Grant + PKCE).

   <img width="1891" height="410" alt="image" src="https://github.com/user-attachments/assets/1779d97e-77e2-4968-8a59-d814e99a8492" />

### 2. MCP Client Configuration

Add to your MCP client's configuration file:

**Claude Code**: `~/.claude.json`
**Cursor IDE**: `.cursor/mcp.json`
**Gemini CLI**: Per Gemini's MCP setup

#### Option A: Using npx (Recommended - No Installation Required)

```json
{
  "mcpServers": {
    "netsuite": {
      "command": "npx",
      "args": ["@suiteinsider/netsuite-mcp@latest"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "your-account-id",
        "NETSUITE_CLIENT_ID": "your-client-id",
        "OAUTH_CALLBACK_PORT": "8080"
      }
    }
  }
}
```

**Benefits**:
- No manual installation required
- Always uses the latest version with `@latest`
- Clean, simple configuration
- Works immediately after MCP client restart

**Optional Environment Variables**:
- `OAUTH_CALLBACK_PORT` - OAuth callback port (default: 8080)

#### Option B: Local Development Setup

For contributing or local development:

```bash
# Clone the repository
git clone https://github.com/dsvantien/netsuite-mcp-server.git
cd netsuite-mcp-server

# Install dependencies
npm install

# Build TypeScript
npm run build

# Test locally with npm link
npm link
```

Then configure with absolute path:

```json
{
  "mcpServers": {
    "netsuite": {
      "command": "node",
      "args": ["/absolute/path/to/netsuite-mcp-server/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "your-account-id",
        "NETSUITE_CLIENT_ID": "your-client-id",
        "OAUTH_CALLBACK_PORT": "8080"
      }
    }
  }
}
```

#### Option C: Without Environment Variables

```json
{
  "mcpServers": {
    "netsuite": {
      "command": "npx",
      "args": ["@suiteinsider/netsuite-mcp@latest"]
    }
  }
}
```

**Note**: You'll need to provide credentials when calling `netsuite_authenticate`

### 3. Authenticate & Use

Start your MCP client and authenticate:

```
Authenticate with NetSuite
```

A browser window opens → Login to NetSuite → Authentication complete!

**Important**: After authentication, you'll need to restart your chat or reconnect the MCP server to see NetSuite tools. This is normal MCP behavior.

Once authenticated, use natural language queries:

```
Show me all customers
List available saved searches
Run a SuiteQL query to get sales orders from last month
Execute the "Monthly Revenue" report
```

## Architecture

```
MCP Client (Claude Code, Cursor, Gemini, etc.)
       │
       │ stdio (JSON-RPC)
       ▼
┌──────────────────────────────┐
│   MCP Server (Node.js/TS)    │
│                              │
│  ┌────────────────────────┐  │
│  │ OAuth Manager          │  │
│  │ - PKCE generation      │  │
│  │ - Local HTTP server    │  │
│  │   (port 8080 default)  │  │
│  │ - Token storage        │  │
│  │ - Auto-refresh         │  │
│  └────────────────────────┘  │
│                              │
│  ┌────────────────────────┐  │
│  │ MCP Tools Proxy        │  │
│  │ - Tool discovery       │  │
│  │ - Tool execution       │  │
│  │ - 401 auto-retry       │  │
│  │ - Metadata caching     │  │
│  └────────────────────────┘  │
│                              │
│  ┌────────────────────────┐  │
│  │ Local Tools            │  │
│  │ - authenticate         │  │
│  │ - logout               │  │
│  │ - refresh_cache        │  │
│  │ - get_record_link      │  │
│  │ - run_parallel_queries │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
       │
       │ HTTPS + Bearer Token
       ▼
┌──────────────────────────────┐
│  NetSuite MCP REST API       │
└──────────────────────────────┘
```

## Project Structure

```
netsuite-mcp-server/
├── src/
│   ├── index.ts               # Server bootstrap & handler wiring
│   ├── handlers/
│   │   └── tools.ts           # Tool registration + local tool handlers
│   ├── mcp/
│   │   └── tools.ts           # NetSuite REST API client (JSON-RPC 2.0)
│   ├── oauth/
│   │   ├── manager.ts         # OAuth flow orchestrator
│   │   ├── pkce.ts            # PKCE challenge/verifier generation
│   │   ├── callbackServer.ts  # HTTP callback server with CSRF protection
│   │   ├── sessionStorage.ts  # Session file management
│   │   └── tokenExchange.ts   # Token exchange & refresh operations
│   └── utils/
│       ├── cache.ts           # Dual-layer cache (L1 memory + L2 filesystem)
│       ├── envValidator.ts    # Zod-based environment variable validation
│       ├── resilience.ts      # Token refresh scheduler
│       ├── netsuiteUrls.ts    # NetSuite UI deep link generation
│       ├── browserLauncher.ts # Cross-platform browser opener
│       └── json.ts            # Non-blocking JSON parser
├── dist/                      # Compiled JavaScript (gitignored)
├── sessions/                  # OAuth tokens (gitignored)
├── .cache/                    # Metadata cache (gitignored)
├── AGENTS.md                  # AI agent operating procedures
├── package.json
├── tsconfig.json
└── README.md
```

## Available Tools

### Local Tools (`netsuite_` prefix)

| Tool | Description |
|------|-------------|
| `netsuite_authenticate` | Start OAuth 2.0 PKCE authentication flow |
| `netsuite_logout` | Clear authentication session |
| `netsuite_refresh_cache` | Force clear local + NetSuite REST session cache |
| `netsuite_get_record_link` | Generate a clickable NetSuite UI link for a record |
| `netsuite_run_parallel_queries` | Execute up to 5 SuiteQL queries concurrently (highly recommended for independent queries) |
| `netsuite_status` | Show diagnostic information (auth state, token expiry, environment, cache stats) |

### NetSuite Proxied Tools (`ns_` prefix)

| Tool | Description |
|------|-------------|
| `ns_runCustomSuiteQL` | Execute SuiteQL queries |
| `ns_getSuiteQLMetadata` | Get schema/metadata for a SuiteQL table |
| `ns_getRecord` | Retrieve a specific record |
| `ns_getRecordTypeMetadata` | Get metadata for a record type |
| `ns_listAllReports` | List available financial reports |
| `ns_runReport` | Execute a specific report |
| `ns_getSubsidiaries` | List subsidiaries |
| `ns_getAccountingBooks` | List accounting books |
| `ns_getAccountingContexts` | List accounting contexts |
| `ns_getNexusIds` | List tax nexuses |
| `ns_createRecord` | Create a new record *(sandbox only)* |
| `ns_updateRecord` | Update an existing record *(sandbox only)* |

> **Note**: Write operations (`ns_createRecord`, `ns_updateRecord`) are automatically disabled in production environments and only available in sandbox/test accounts.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NETSUITE_ACCOUNT_ID` | Optional* | — | NetSuite account ID |
| `NETSUITE_CLIENT_ID` | Optional* | — | OAuth 2.0 client ID |
| `OAUTH_CALLBACK_PORT` | No | `8080` | OAuth callback port |
| `NETSUITE_SESSION_PATH` | No | `./sessions/<accountId>` | Custom session directory |

*\* Can be provided at runtime via `netsuite_authenticate` arguments instead.*

### Resolution Order

1. **Check arguments first**: If `accountId` or `clientId` provided as arguments, use them
2. **Fallback to environment variables**: If no arguments, use env vars
3. **Validation**: If neither source provides credentials, show error with instructions

## Multi-Environment Isolation

Run multiple NetSuite environments concurrently with isolated sessions:

```json
{
  "mcpServers": {
    "netsuite_prod": {
      "command": "npx",
      "args": ["@suiteinsider/netsuite-mcp@latest"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "123456",
        "NETSUITE_CLIENT_ID": "your-prod-client-id",
        "OAUTH_CALLBACK_PORT": "8080",
        "NETSUITE_SESSION_PATH": "/path/to/sessions/prod"
      }
    },
    "netsuite_sb1": {
      "command": "npx",
      "args": ["@suiteinsider/netsuite-mcp@latest"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "123456_SB1",
        "NETSUITE_CLIENT_ID": "your-sb1-client-id",
        "OAUTH_CALLBACK_PORT": "8081",
        "NETSUITE_SESSION_PATH": "/path/to/sessions/sb1"
      }
    }
  }
}
```

This guarantees:
1. **No Session Collision**: OAuth flows and tokens are stored separately.
2. **Data Quarantine**: Processes run on strict account scopes and cannot access other databases.

### Workspace-Based Safety Isolation
To prevent accidental cross-account or cross-environment operations when working in an IDE:
- The server automatically inspects open workspaces via the MCP `listRoots` capability.
- If a workspace contains a `project.json` (NetSuite SuiteCloud config), the server extracts its `defaultAuthId`.
- If the project's target account ID does not match the active NetSuite session's account ID, the server **hides all business tools** (allowing only administrative tools like `netsuite_authenticate`, `netsuite_logout`, and `netsuite_status`) and **blocks tool execution** at runtime.
- A clear warning is appended to the description of the remaining administrative tools in the tool list to notify you.

## OAuth Flow

1. **Initiation**: User calls `netsuite_authenticate` with credentials
2. **PKCE Generation**: Server generates code verifier and SHA-256 challenge
3. **Authorization URL**: Server generates NetSuite OAuth URL and starts local callback server
4. **User Login**: Browser opens NetSuite login page
5. **Authorization**: User approves access
6. **Callback**: NetSuite redirects to `http://localhost:8080/callback` with authorization code
7. **Token Exchange**: Server exchanges code for access/refresh tokens (public client pattern)
8. **Session Storage**: Tokens stored in session files (persists across restarts)
9. **Auto-Refresh**: Tokens automatically refresh when expiring (5-minute buffer)

## Development

### Commands

| Command | Description |
|---|---|
| `npm run build` | Clean build (`rimraf dist && tsc`) |
| `npm test` | Run all Jest tests |
| `npm run start` | Start in production mode (from `dist/`) |
| `npm run dev` | Start in development mode (via `tsx`) |

### Clearing Session

```bash
rm -rf sessions/
```

Or use the `netsuite_logout` tool in your MCP client.

### Viewing Logs

All server logs output to stderr. When running in MCP clients, these logs appear in the client's console/logs.

## Troubleshooting

### Issue: "Port already in use"

**Cause**: Another application using the OAuth callback port

**Solution**:
```bash
# Check what's using the port (example for port 8080)
lsof -i :8080

# Option 1: Kill the process
# Option 2: Change port via environment variable
```

Set custom port in your MCP config:
```json
{
  "env": {
    "OAUTH_CALLBACK_PORT": "9000"
  }
}
```

**Remember to update the redirect URI in your NetSuite integration to match the new port!**

### Issue: Tools not appearing after authentication

**Cause**: MCP clients cache tool list at session start

**Solution**:
- **Restart chat** - Open new conversation
- **Reconnect MCP** - Use `/mcp` command (Claude Code)
- **Restart app** - Close and reopen your IDE

This is normal MCP behavior - tool lists are fetched once per session.

## Prerequisites

- **Node.js** 18.0.0 or higher
- **NetSuite Account** with MCP access
- **NetSuite AI Connector SuiteApp** (Bundle ID: 522506) installed and configured
- **NetSuite Integration Record** with OAuth 2.0 and PKCE enabled
- **MCP Client** - Any MCP-compatible client (Claude Code, Cursor IDE, Gemini CLI, etc.)

## License

MIT

## References

- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [NetSuite OAuth 2.0 Documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158081952044.html)
- [PKCE Specification (RFC 7636)](https://datatracker.ietf.org/doc/html/rfc7636)
