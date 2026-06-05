import crypto from 'crypto';

/**
 * PKCE (Proof Key for Code Exchange) utilities
 * Used for OAuth 2.0 public client authentication
 */

/**
 * Base64URL encoding (no padding)
 */
export function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export interface PKCEChallenge {
  code_verifier: string;
  code_challenge: string;
  code_challenge_method: string;
}

/**
 * Generate PKCE challenge and verifier
 */
export function generatePKCE(): PKCEChallenge {
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(
    crypto.createHash('sha256').update(verifier).digest()
  );

  return {
    code_verifier: verifier,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  };
}
