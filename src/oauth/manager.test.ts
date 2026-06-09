import { OAuthManager } from './manager.js';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

describe('OAuthManager - Concurrent Refresh', () => {
  const testStoragePath = path.join(process.cwd(), '.test-manager-storage');
  let manager: OAuthManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.rm(testStoragePath, { recursive: true, force: true });
    manager = new OAuthManager({ storagePath: testStoragePath });
  });

  afterEach(async () => {
    manager.stopProactiveRefresh();
    await fs.rm(testStoragePath, { recursive: true, force: true });
  });

  it('should only call refreshAccessToken once during concurrent ensureValidToken calls', async () => {
    // Setup a session with a token expiring in 1 minute (should trigger refresh)
    const mockSession = {
      authenticated: true,
      tokens: {
        access_token: 'old-access-token',
        refresh_token: 'my-refresh-token',
        expires_in: 3600,
        expires_at: Date.now() + 60 * 1000, // expiring in 1 minute
        accountId: '123456',
        clientId: 'my-client-id'
      }
    };

    await fs.mkdir(testStoragePath, { recursive: true });
    await fs.writeFile(
      path.join(testStoragePath, 'session.json'),
      JSON.stringify(mockSession),
      'utf-8'
    );

    // Mock axios post with a slight delay to simulate concurrency overlapping
    let postCallCount = 0;
    const axiosSpy = jest.spyOn(axios, 'post').mockImplementation(() => {
      postCallCount++;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            data: {
              access_token: 'refreshed-access-token',
              refresh_token: 'refreshed-refresh-token',
              expires_in: 3600
            }
          } as any);
        }, 50);
      });
    });

    // Fire two concurrent calls
    const [token1, token2] = await Promise.all([
      manager.ensureValidToken(),
      manager.ensureValidToken()
    ]);

    // Both should get the new token
    expect(token1).toBe('refreshed-access-token');
    expect(token2).toBe('refreshed-access-token');

    // Only one HTTP request should have been made
    expect(postCallCount).toBe(1);

    axiosSpy.mockRestore();
  });

  it('should only call refreshAccessToken once during concurrent forceRefreshToken calls', async () => {
    const mockSession = {
      authenticated: true,
      tokens: {
        access_token: 'old-access-token',
        refresh_token: 'my-refresh-token',
        expires_in: 3600,
        expires_at: Date.now() + 3000 * 1000, // valid
        accountId: '123456',
        clientId: 'my-client-id'
      }
    };

    await fs.mkdir(testStoragePath, { recursive: true });
    await fs.writeFile(
      path.join(testStoragePath, 'session.json'),
      JSON.stringify(mockSession),
      'utf-8'
    );

    let postCallCount = 0;
    const axiosSpy = jest.spyOn(axios, 'post').mockImplementation(() => {
      postCallCount++;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            data: {
              access_token: 'forced-access-token',
              refresh_token: 'my-refresh-token',
              expires_in: 3600
            }
          } as any);
        }, 50);
      });
    });

    // Fire two concurrent force calls
    const [token1, token2] = await Promise.all([
      manager.forceRefreshToken('old-access-token'),
      manager.forceRefreshToken('old-access-token')
    ]);

    expect(token1).toBe('forced-access-token');
    expect(token2).toBe('forced-access-token');
    expect(postCallCount).toBe(1);

    axiosSpy.mockRestore();
  });

  it('should bypass refresh if failedToken does not match currentToken', async () => {
    const mockSession = {
      authenticated: true,
      tokens: {
        access_token: 'already-refreshed-token',
        refresh_token: 'my-refresh-token',
        expires_in: 3600,
        expires_at: Date.now() + 3000 * 1000,
        accountId: '123456',
        clientId: 'my-client-id'
      }
    };

    await fs.mkdir(testStoragePath, { recursive: true });
    await fs.writeFile(
      path.join(testStoragePath, 'session.json'),
      JSON.stringify(mockSession),
      'utf-8'
    );

    const axiosSpy = jest.spyOn(axios, 'post');

    // Call with the token we think failed (which is 'old-token')
    // But current token is 'already-refreshed-token'.
    // It should return 'already-refreshed-token' immediately without calling refreshAccessToken.
    const token = await manager.forceRefreshToken('old-token');

    expect(token).toBe('already-refreshed-token');
    expect(axiosSpy).not.toHaveBeenCalled();

    axiosSpy.mockRestore();
  });
});
