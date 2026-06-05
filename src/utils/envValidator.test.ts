import { describe, it, expect } from '@jest/globals';
import { validateEnv } from './envValidator.js';

describe('Env Validator', () => {
  it('should pass on valid or empty inputs with default callback port', () => {
    const mockEnv = {
      NETSUITE_ACCOUNT_ID: '123456',
      NETSUITE_CLIENT_ID: 'abc-def',
    };
    const config = validateEnv(mockEnv);
    expect(config.OAUTH_CALLBACK_PORT).toBe(8080);
    expect(config.NETSUITE_ACCOUNT_ID).toBe('123456');
    expect(config.NETSUITE_CLIENT_ID).toBe('abc-def');
  });

  it('should parse OAUTH_CALLBACK_PORT correctly', () => {
    const mockEnv = {
      OAUTH_CALLBACK_PORT: '9090',
    };
    const config = validateEnv(mockEnv);
    expect(config.OAUTH_CALLBACK_PORT).toBe(9090);
  });

  it('should throw error on invalid OAUTH_CALLBACK_PORT', () => {
    const mockEnv = {
      OAUTH_CALLBACK_PORT: 'invalid-port',
    };
    expect(() => validateEnv(mockEnv)).toThrow('Environment validation failed');
  });

  it('should throw error on out-of-range PORT', () => {
    const mockEnv = {
      PORT: '70000',
    };
    expect(() => validateEnv(mockEnv)).toThrow('Environment validation failed');
  });
});
