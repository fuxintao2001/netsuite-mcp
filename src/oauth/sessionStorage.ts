import fs from 'fs/promises';
import path from 'path';

export interface SessionData {
  pkce?: string | null;
  state?: string;
  config?: {
    accountId: string;
    clientId: string;
    redirectUri: string;
  };
  tokens?: TokenData;
  timestamp?: number;
  authenticated?: boolean;
}

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  accountId: string;
  clientId: string;
}

/**
 * Session storage for OAuth tokens
 * Handles reading and writing session data to disk
 */
export class SessionStorage {
  private storagePath: string;
  private sessionFile: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.sessionFile = path.join(storagePath, 'session.json');
  }

  /**
   * Save session data to file
   */
  async save(data: SessionData): Promise<void> {
    try {
      await fs.mkdir(this.storagePath, { recursive: true });
      await fs.writeFile(this.sessionFile, JSON.stringify(data, null, 2));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to save session:', message);
      throw error;
    }
  }

  /**
   * Load session data from file
   */
  async load(): Promise<SessionData | null> {
    try {
      const data = await fs.readFile(this.sessionFile, 'utf-8');
      try {
        return JSON.parse(data) as SessionData;
      } catch (parseError: unknown) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        console.error(`⚠️ Session file is corrupted, clearing: ${message}`);
        await this.clear();
        return null;
      }
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return null; // Session file doesn't exist
      }
      throw error;
    }
  }

  /**
   * Clear session file (logout)
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.sessionFile);
      console.error('✅ Session cleared');
    } catch {
      // Session file doesn't exist, ignore
    }
  }

  /**
   * Check if session exists and is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      const session = await this.load();
      return !!(session && session.authenticated && session.tokens);
    } catch {
      return false;
    }
  }
}
