import { generateNetSuiteUrl } from './netsuiteUrls.js';
import { describe, it, expect } from '@jest/globals';

describe('netsuiteUrls', () => {
  const accountId = '123456_SB1';
  const formattedAccountId = '123456-sb1';

  it('should return null if accountId or recordId is missing', () => {
    expect(generateNetSuiteUrl('', 'customer', 123)).toBeNull();
    expect(generateNetSuiteUrl(accountId, 'customer', '')).toBeNull();
  });

  it('should format accountId correctly (lowercase and replace underscores with hyphens)', () => {
    const url = generateNetSuiteUrl('123456_SB2', 'customer', 789);
    expect(url).toContain('https://123456-sb2.app.netsuite.com');
  });

  it('should resolve standard entities (e.g. customer)', () => {
    const url = generateNetSuiteUrl(accountId, 'customer', 123);
    expect(url).toBe(`https://${formattedAccountId}.app.netsuite.com/app/common/entity/custjob.nl?id=123`);
  });

  it('should resolve standard transactions (e.g. salesorder)', () => {
    const url = generateNetSuiteUrl(accountId, 'salesorder', 456);
    expect(url).toBe(`https://${formattedAccountId}.app.netsuite.com/app/accounting/transactions/salesord.nl?id=456`);
  });

  it('should handle recordType with irregular spaces and casing', () => {
    const url = generateNetSuiteUrl(accountId, 'Sales Order', 456);
    expect(url).toBe(`https://${formattedAccountId}.app.netsuite.com/app/accounting/transactions/salesord.nl?id=456`);
  });

  it('should resolve custom records using script ID prefix', () => {
    const url = generateNetSuiteUrl(accountId, 'customrecord_my_custom_type', 999);
    expect(url).toBe(`https://${formattedAccountId}.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=customrecord_my_custom_type&id=999`);
  });

  it('should prioritize rectype parameter if explicitly provided', () => {
    const url = generateNetSuiteUrl(accountId, 'customrecord_some_type', 999, 12345);
    expect(url).toBe(`https://${formattedAccountId}.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=12345&id=999`);
  });

  it('should fallback to transaction.nl for unknown record types', () => {
    const url = generateNetSuiteUrl(accountId, 'unknown_record_type', 999);
    expect(url).toBe(`https://${formattedAccountId}.app.netsuite.com/app/accounting/transactions/transaction.nl?id=999`);
  });
});
