import axios from 'axios';
import type { TokenData } from './sessionStorage.js';

/**
 * NetSuite OAuth token exchange utilities
 * Handles token exchange and refresh operations
 */

/**
 * Custom error class for token refresh failures.
 * `recoverable` indicates whether the caller should retry or force re-authentication.
 */
export class TokenRefreshError extends Error {
  readonly recoverable: boolean;
  constructor(message: string, recoverable: boolean) {
    super(message);
    this.name = 'TokenRefreshError';
    this.recoverable = recoverable;
  }
}

interface OAuthConfig {
  accountId: string;
  clientId: string;
  redirectUri: string;
}

/**
 * Exchange authorization code for access/refresh tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  config: OAuthConfig,
  codeVerifier: string
): Promise<TokenData> {
  const tokenUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

  // CRITICAL: For Public Client with PKCE - all params in body, NO Authorization header
  const params = {
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier
  };

  console.error('🔄 Exchanging authorization code for tokens...');

  try {
    const response = await axios.post(tokenUrl, new URLSearchParams(params), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });

    const tokens: TokenData = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in,
      expires_at: Date.now() + (response.data.expires_in * 1000),
      accountId: config.accountId,
      clientId: config.clientId
    };

    console.error('✅ Tokens obtained successfully');
    return tokens;

  } catch (error: unknown) {
    const err = error as { response?: { data?: unknown; status?: number }; message?: string };
    console.error('❌ Token exchange error:', err.response?.data || err.message);
    throw new Error(`Failed to exchange authorization code: ${err.response?.status || err.message}`);
  }
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(tokens: TokenData): Promise<TokenData> {
  const { refresh_token, accountId, clientId } = tokens;
  const tokenUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

  // For Public Client: include client_id in body
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refresh_token,
    client_id: clientId
  };

  console.error('🔄 Refreshing access token...');

  try {
    const response = await axios.post(tokenUrl, new URLSearchParams(params), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });

    const newTokens: TokenData = {
      ...tokens,
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token || refresh_token,
      expires_in: response.data.expires_in,
      expires_at: Date.now() + (response.data.expires_in * 1000)
    };

    console.error('✅ Token refreshed successfully');
    return newTokens;

  } catch (error: unknown) {
    const err = error as { response?: { data?: unknown; status?: number }; message?: string };
    console.error('❌ Token refresh failed:', err.response?.data || err.message);
    const status = err.response?.status;
    // 400/401 means the refresh_token itself is invalid/expired — unrecoverable
    const recoverable = !(status === 400 || status === 401);
    throw new TokenRefreshError(
      `Failed to refresh access token${recoverable ? ' (transient)' : ' (refresh token expired)'}. Please re-authenticate.`,
      recoverable
    );
  }
}

/**
 * Check if token needs refresh (expires in less than 5 minutes)
 */
export function shouldRefreshToken(tokens: TokenData): boolean {
  const timeUntilExpiry = tokens.expires_at - Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  return timeUntilExpiry < fiveMinutes;
}
