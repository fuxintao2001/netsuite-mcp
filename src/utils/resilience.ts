/**
 * Connection Resilience Utilities
 * Provides retry logic and proactive token refresh scheduling
 */

// --- Environment-configurable constants ---
const MAX_RETRIES = parseInt(process.env.MCP_MAX_RETRIES || '1', 10);
const RETRY_DELAY_MS = parseInt(process.env.MCP_RETRY_DELAY_MS || '1000', 10);
const TOKEN_CHECK_INTERVAL_MS = parseInt(process.env.MCP_TOKEN_CHECK_INTERVAL_MS || '60000', 10); // 1 minute

export interface RetryOptions {
  /** Maximum number of retries (default: from MCP_MAX_RETRIES env, or 1) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: from MCP_RETRY_DELAY_MS env, or 1000) */
  initialDelayMs?: number;
  /** Optional predicate: return true if the error is retryable */
  isRetryable?: (error: unknown) => boolean;
  /** Label for logging */
  label?: string;
}

/**
 * Execute an async function with retry and exponential backoff.
 * By default retries once with 1s delay.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const initialDelay = options.initialDelayMs ?? RETRY_DELAY_MS;
  const isRetryable = options.isRetryable ?? (() => true);
  const label = options.label ?? 'operation';

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      const delay = initialDelay * Math.pow(2, attempt);
      console.error(`🔄 [Retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${message}`);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Check if an HTTP error is transient and worth retrying
 */
export function isTransientError(error: unknown): boolean {
  const err = error as { response?: { status?: number }; code?: string; message?: string };
  // Network errors (no response received)
  if (!err.response && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
      err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.code === 'EPIPE' ||
      err.message?.includes('timeout') || err.message?.includes('socket hang up'))) {
    return true;
  }

  // HTTP status codes that are transient
  const status = err.response?.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  return false;
}

/** Minimal interface for the OAuthManager used by the scheduler */
interface TokenRefreshTarget {
  hasValidSession(): Promise<boolean>;
  ensureValidToken(): Promise<string>;
}

/**
 * Proactive Token Refresh Scheduler
 * Periodically checks if the OAuth token is expiring soon and refreshes it proactively,
 * preventing silent token expiration during idle periods.
 */
export class TokenRefreshScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private oauthManager: TokenRefreshTarget;
  private checkIntervalMs: number;

  constructor(oauthManager: TokenRefreshTarget, checkIntervalMs?: number) {
    this.oauthManager = oauthManager;
    this.checkIntervalMs = checkIntervalMs ?? TOKEN_CHECK_INTERVAL_MS;
  }

  /**
   * Start the proactive refresh scheduler
   */
  start(): void {
    if (this.intervalId) {
      return; // Already running
    }

    console.error(`🔄 [TokenRefreshScheduler] Started — checking every ${this.checkIntervalMs / 1000}s`);

    this.intervalId = setInterval(async () => {
      try {
        const hasSession = await this.oauthManager.hasValidSession();
        if (!hasSession) {
          return; // Not authenticated, nothing to refresh
        }

        // ensureValidToken() will auto-refresh if within 5-minute window
        await this.oauthManager.ensureValidToken();
        console.error('🔄 [TokenRefreshScheduler] Token validity check completed');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`⚠️ [TokenRefreshScheduler] Proactive refresh failed: ${message}`);
        // Don't rethrow — this is a background task, we just log and continue
      }
    }, this.checkIntervalMs);

    // Ensure the interval doesn't prevent process exit
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      this.intervalId.unref();
    }
  }

  /**
   * Stop the proactive refresh scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.error('🔄 [TokenRefreshScheduler] Stopped');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
