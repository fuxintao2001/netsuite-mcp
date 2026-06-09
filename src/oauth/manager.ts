import crypto from 'crypto';
import { generatePKCE } from './pkce.js';
import type { PKCEChallenge } from './pkce.js';
import { CallbackServer } from './callbackServer.js';
import { SessionStorage } from './sessionStorage.js';
import type { TokenData } from './sessionStorage.js';
import { exchangeCodeForTokens, refreshAccessToken, shouldRefreshToken, TokenRefreshError } from './tokenExchange.js';
import { TokenRefreshScheduler } from '../utils/resilience.js';
import { openBrowser } from '../utils/browserLauncher.js';

interface OAuthManagerConfig {
  storagePath?: string;
  callbackPort?: number;
}

interface AuthFlowConfig {
  accountId: string;
  clientId: string;
}

/**
 * OAuth Manager for NetSuite OAuth 2.0 with PKCE
 * Handles authorization flow, token exchange, and automatic token refresh
 */
export class OAuthManager {
  private callbackPort: number;
  private storage: SessionStorage;
  private callbackServer: CallbackServer;
  private tokenRefreshScheduler: TokenRefreshScheduler;
  private refreshPromise: Promise<string> | null = null;
  private refreshingToken: string | null = null;

  constructor(config: OAuthManagerConfig = {}) {
    this.callbackPort = config.callbackPort || 8080;
    this.storage = new SessionStorage(config.storagePath || './sessions');
    this.callbackServer = new CallbackServer(this.callbackPort);
    this.tokenRefreshScheduler = new TokenRefreshScheduler(this);
  }

  /**
   * Start OAuth flow with local callback server
   */
  async startAuthFlow(config: AuthFlowConfig): Promise<string> {
    const { accountId, clientId } = config;

    if (!accountId || !clientId) {
      throw new Error('accountId and clientId are required');
    }

    const pkce = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `http://localhost:${this.callbackPort}/callback`;

    // Store PKCE and config (critical: must persist until callback)
    await this.storage.save({
      pkce: pkce.code_verifier,
      state,
      config: { accountId, clientId, redirectUri },
      timestamp: Date.now()
    });

    // Generate authorization URL
    const authUrl = this.buildAuthorizationUrl(accountId, clientId, redirectUri, state, pkce);

    console.error(`\n🔐 NetSuite Authentication Required`);
    console.error(`📋 Opening browser for authentication...\n`);

    // Automatically open browser
    await openBrowser(authUrl);

    console.error(`📋 If browser didn't open, use this URL:\n`);
    console.error(`   ${authUrl}\n`);
    console.error(`⏳ Waiting for authentication...`);

    // Start callback server and wait for OAuth callback
    try {
      await this.callbackServer.start(state, async (code: string) => {
        await this.handleAuthorizationCode(code);
      });
      console.error(`✅ Authentication successful!\n`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Authentication failed: ${message}\n`);
      throw error;
    }

    return authUrl;
  }

  /**
   * Build authorization URL for NetSuite OAuth
   */
  private buildAuthorizationUrl(
    accountId: string,
    clientId: string,
    redirectUri: string,
    state: string,
    pkce: PKCEChallenge
  ): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'mcp',
      state: state,
      code_challenge: pkce.code_challenge,
      code_challenge_method: pkce.code_challenge_method
    });

    return `https://${accountId}.app.netsuite.com/app/login/oauth2/authorize.nl?${params}`;
  }

  /**
   * Handle authorization code from OAuth callback
   */
  private async handleAuthorizationCode(code: string): Promise<void> {
    const session = await this.storage.load();

    if (!session || !session.pkce) {
      throw new Error('Invalid session or PKCE challenge not found. Please try connecting again.');
    }

    const { pkce: verifier, config } = session;

    if (!config || !verifier) {
      throw new Error('Session is missing required OAuth config. Please try connecting again.');
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, config, verifier);

    // Store tokens in session
    await this.storage.save({
      ...session,
      tokens,
      pkce: null, // Clear PKCE after successful exchange
      authenticated: true
    });
  }

  /**
   * Helper to execute a token refresh with a single shared promise to prevent concurrent duplication
   */
  private async executeTokenRefresh(session: any, tokenToRefresh: string): Promise<string> {
    this.refreshingToken = tokenToRefresh;
    this.refreshPromise = (async () => {
      try {
        const newTokens = await refreshAccessToken(session.tokens);
        await this.storage.save({
          ...session,
          tokens: newTokens
        });
        return newTokens.access_token;
      } catch (error: unknown) {
        if (error instanceof TokenRefreshError && !error.recoverable) {
          console.error('🔒 Refresh token expired — clearing invalid session');
          await this.clearSession();
        }
        throw error;
      } finally {
        this.refreshPromise = null;
        this.refreshingToken = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Ensure token is valid, auto-refresh if expiring soon
   */
  async ensureValidToken(): Promise<string> {
    const session = await this.storage.load();

    if (!session || !session.tokens) {
      throw new Error('Not authenticated. Please run authentication first.');
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Refresh if expiring in < 5 minutes
    if (shouldRefreshToken(session.tokens)) {
      console.error('⚠️  Token expiring soon, refreshing...');
      return this.executeTokenRefresh(session, session.tokens.access_token);
    }

    return session.tokens.access_token;
  }

  /**
   * Force refresh the access token (used by retry logic after 401)
   */
  async forceRefreshToken(failedToken?: string): Promise<string> {
    const session = await this.storage.load();
    if (!session || !session.tokens) {
      throw new Error('Not authenticated. Please run authentication first.');
    }

    const currentToken = session.tokens.access_token;

    // If the token was already refreshed by another concurrent request, return it immediately
    if (failedToken && currentToken !== failedToken) {
      console.error('🔄 Token was already refreshed by another request.');
      return currentToken;
    }

    // If a refresh is already in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    console.error('🔄 Force-refreshing access token...');
    return this.executeTokenRefresh(session, currentToken);
  }

  /**
   * Check if has valid authenticated session
   */
  async hasValidSession(): Promise<boolean> {
    return await this.storage.isAuthenticated();
  }

  /**
   * Get account ID from session
   */
  async getAccountId(): Promise<string | undefined> {
    const session = await this.storage.load();
    return session?.tokens?.accountId;
  }

  /**
   * Get diagnostic info about the current session.
   * Used by the netsuite_status tool.
   */
  async getSessionInfo(): Promise<{
    authenticated: boolean;
    accountId?: string;
    clientId?: string;
    tokenExpiresAt?: number;
    tokenExpiresIn?: number;
    refreshSchedulerActive: boolean;
  }> {
    const session = await this.storage.load();
    const authenticated = !!(session?.authenticated && session?.tokens);

    if (!authenticated || !session?.tokens) {
      return { authenticated: false, refreshSchedulerActive: this.tokenRefreshScheduler.isRunning() };
    }

    const now = Date.now();
    const expiresAt = session.tokens.expires_at;
    const expiresInMs = expiresAt ? expiresAt - now : undefined;

    return {
      authenticated: true,
      accountId: session.tokens.accountId,
      clientId: session.tokens.clientId,
      tokenExpiresAt: expiresAt,
      tokenExpiresIn: expiresInMs ? Math.max(0, Math.round(expiresInMs / 1000)) : undefined,
      refreshSchedulerActive: this.tokenRefreshScheduler.isRunning()
    };
  }

  /**
   * Clear session (logout)
   */
  async clearSession(): Promise<void> {
    this.stopProactiveRefresh();
    await this.storage.clear();
  }

  /**
   * Start the proactive token refresh scheduler
   */
  startProactiveRefresh(): void {
    this.tokenRefreshScheduler.start();
  }

  /**
   * Stop the proactive token refresh scheduler
   */
  stopProactiveRefresh(): void {
    this.tokenRefreshScheduler.stop();
  }
}
