import { exchangeCodeForTokens, refreshAccessToken, shouldRefreshToken } from './tokenExchange.js';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import axios from 'axios';

describe('tokenExchange', () => {
  const mockConfig = {
    accountId: '123456',
    clientId: 'my-client-id',
    redirectUri: 'http://localhost:8080/callback'
  };
  const mockCode = 'auth-code-123';
  const mockVerifier = 'verifier-abc';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('exchangeCodeForTokens', () => {
    it('should successfully exchange authorization code for tokens', async () => {
      const mockResponse = {
        data: {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600
        }
      };

      const spy = jest.spyOn(axios, 'post').mockResolvedValueOnce(mockResponse as any);

      const tokens = await exchangeCodeForTokens(mockCode, mockConfig, mockVerifier);

      expect(spy).toHaveBeenCalledWith(
        `https://123456.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`,
        expect.any(URLSearchParams),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      // Verify the post request body content
      const urlParamsCall = spy.mock.calls[0][1] as URLSearchParams;
      expect(urlParamsCall.get('grant_type')).toBe('authorization_code');
      expect(urlParamsCall.get('code')).toBe(mockCode);
      expect(urlParamsCall.get('redirect_uri')).toBe(mockConfig.redirectUri);
      expect(urlParamsCall.get('client_id')).toBe(mockConfig.clientId);
      expect(urlParamsCall.get('code_verifier')).toBe(mockVerifier);

      // Verify return values
      expect(tokens.access_token).toBe('new-access-token');
      expect(tokens.refresh_token).toBe('new-refresh-token');
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.accountId).toBe(mockConfig.accountId);
      expect(tokens.clientId).toBe(mockConfig.clientId);
      expect(tokens.expires_at).toBeGreaterThan(Date.now());
    });

    it('should throw an error if the request fails', async () => {
      const mockError = {
        response: {
          status: 400,
          data: { error: 'invalid_grant' }
        }
      };
      
      jest.spyOn(axios, 'post').mockRejectedValueOnce(mockError as any);

      await expect(
        exchangeCodeForTokens(mockCode, mockConfig, mockVerifier)
      ).rejects.toThrow('Failed to exchange authorization code: 400');
    });
  });

  describe('refreshAccessToken', () => {
    it('should successfully refresh access token', async () => {
      const mockTokens = {
        access_token: 'old-access-token',
        refresh_token: 'my-refresh-token',
        expires_in: 3600,
        expires_at: Date.now() - 1000,
        accountId: '123456',
        clientId: 'my-client-id'
      };

      const mockResponse = {
        data: {
          access_token: 'refreshed-access-token',
          refresh_token: 'refreshed-refresh-token',
          expires_in: 1800
        }
      };

      const spy = jest.spyOn(axios, 'post').mockResolvedValueOnce(mockResponse as any);

      const refreshed = await refreshAccessToken(mockTokens);

      expect(spy).toHaveBeenCalledWith(
        `https://123456.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`,
        expect.any(URLSearchParams),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const urlParamsCall = spy.mock.calls[0][1] as URLSearchParams;
      expect(urlParamsCall.get('grant_type')).toBe('refresh_token');
      expect(urlParamsCall.get('refresh_token')).toBe(mockTokens.refresh_token);
      expect(urlParamsCall.get('client_id')).toBe(mockTokens.clientId);

      expect(refreshed.access_token).toBe('refreshed-access-token');
      expect(refreshed.refresh_token).toBe('refreshed-refresh-token');
      expect(refreshed.expires_in).toBe(1800);
      expect(refreshed.expires_at).toBeGreaterThan(Date.now());
    });

    it('should fallback to old refresh token if new one is not returned', async () => {
      const mockTokens = {
        access_token: 'old-access-token',
        refresh_token: 'my-refresh-token',
        expires_in: 3600,
        expires_at: Date.now() - 1000,
        accountId: '123456',
        clientId: 'my-client-id'
      };

      const mockResponse = {
        data: {
          access_token: 'refreshed-access-token',
          expires_in: 1800
        }
      };

      jest.spyOn(axios, 'post').mockResolvedValueOnce(mockResponse as any);

      const refreshed = await refreshAccessToken(mockTokens);
      expect(refreshed.refresh_token).toBe('my-refresh-token');
    });

    it('should throw an error if refresh fails', async () => {
      jest.spyOn(axios, 'post').mockRejectedValueOnce(new Error('Network error') as any);

      await expect(
        refreshAccessToken({
          refresh_token: 'xyz',
          accountId: '123',
          clientId: '456'
        })
      ).rejects.toThrow('Failed to refresh access token. Please re-authenticate.');
    });
  });

  describe('shouldRefreshToken', () => {
    it('should return true if token is expired or expiring in under 5 minutes', () => {
      const expiredTokens = {
        expires_at: Date.now() + 4 * 60 * 1000 // 4 minutes from now
      };
      expect(shouldRefreshToken(expiredTokens as any)).toBe(true);
    });

    it('should return false if token is valid for more than 5 minutes', () => {
      const validTokens = {
        expires_at: Date.now() + 10 * 60 * 1000 // 10 minutes from now
      };
      expect(shouldRefreshToken(validTokens as any)).toBe(false);
    });
  });
});
