import { base64URLEncode, generatePKCE } from './pkce.js';
import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';

describe('pkce', () => {
  describe('base64URLEncode', () => {
    it('should correctly encode buffer and replace special chars (+ with -, / with _)', () => {
      const buffer = Buffer.from([251, 255, 191]); // contains bytes that map to + and / in standard base64
      const standardBase64 = buffer.toString('base64');
      expect(standardBase64).toContain('+');
      expect(standardBase64).toContain('/');
      
      const urlEncoded = base64URLEncode(buffer);
      expect(urlEncoded).not.toContain('+');
      expect(urlEncoded).not.toContain('/');
      expect(urlEncoded).not.toContain('=');
      expect(urlEncoded).toBe('-_-_');
    });

    it('should strip trailing equals (padding)', () => {
      const buffer = Buffer.from('hello');
      const standardBase64 = buffer.toString('base64');
      expect(standardBase64).toContain('=');
      
      const urlEncoded = base64URLEncode(buffer);
      expect(urlEncoded).not.toContain('=');
      expect(urlEncoded).toBe('aGVsbG8');
    });
  });

  describe('generatePKCE', () => {
    it('should generate a code verifier and code challenge with SHA256 method', () => {
      const pkce = generatePKCE();
      
      expect(pkce.code_challenge_method).toBe('S256');
      expect(pkce.code_verifier).toBeDefined();
      expect(typeof pkce.code_verifier).toBe('string');
      
      // A standard 32-byte verifier base64url encoded is 43 characters long
      expect(pkce.code_verifier.length).toBe(43);
      
      expect(pkce.code_challenge).toBeDefined();
      expect(typeof pkce.code_challenge).toBe('string');
      expect(pkce.code_challenge.length).toBe(43);

      // Verify that the code_challenge is indeed the SHA256 of code_verifier
      const expectedChallenge = base64URLEncode(
        crypto.createHash('sha256').update(pkce.code_verifier).digest()
      );
      expect(pkce.code_challenge).toBe(expectedChallenge);
    });
  });
});
