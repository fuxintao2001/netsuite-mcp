const RECORD_URL_MAP: Record<string, string> = {
  // Entities
  'customer': '/app/common/entity/custjob.nl',
  'custjob': '/app/common/entity/custjob.nl',
  'lead': '/app/common/entity/custjob.nl',
  'prospect': '/app/common/entity/custjob.nl',
  'project': '/app/common/entity/custjob.nl',
  'job': '/app/common/entity/custjob.nl',
  'vendor': '/app/common/entity/vendor.nl',
  'employee': '/app/common/entity/employee.nl',
  'contact': '/app/common/entity/contact.nl',
  'partner': '/app/common/entity/partner.nl',
  
  // CRM
  'supportcase': '/app/crm/support/supportcase.nl',
  'case': '/app/crm/support/supportcase.nl',
  'task': '/app/common/entity/task.nl',
  'phonecall': '/app/crm/calendar/call.nl',
  'message': '/app/common/entity/message.nl',
  'opportunity': '/app/accounting/transactions/opprtnty.nl',
  'opprtnty': '/app/accounting/transactions/opprtnty.nl',
  
  // Transactions (Direct URL paths)
  'salesorder': '/app/accounting/transactions/salesord.nl',
  'salesord': '/app/accounting/transactions/salesord.nl',
  'invoice': '/app/accounting/transactions/custinvc.nl',
  'custinvc': '/app/accounting/transactions/custinvc.nl',
  'purchaseorder': '/app/accounting/transactions/purchord.nl',
  'purchord': '/app/accounting/transactions/purchord.nl',
  'vendorbill': '/app/accounting/transactions/vendbill.nl',
  'vendbill': '/app/accounting/transactions/vendbill.nl',
  'cashsale': '/app/accounting/transactions/cashsale.nl',
  'estimate': '/app/accounting/transactions/estimate.nl',
  'quote': '/app/accounting/transactions/estimate.nl',
  'custpymt': '/app/accounting/transactions/custpymt.nl',
  'customerpayment': '/app/accounting/transactions/custpymt.nl',
  'vendpymt': '/app/accounting/transactions/vendpymt.nl',
  'vendorpayment': '/app/accounting/transactions/vendpymt.nl',
  'journalentry': '/app/accounting/transactions/journal.nl',
  'journal': '/app/accounting/transactions/journal.nl',
  'creditmemo': '/app/accounting/transactions/custcred.nl',
  'custcred': '/app/accounting/transactions/custcred.nl',
  'vendorcredit': '/app/accounting/transactions/vendcred.nl',
  'vendcred': '/app/accounting/transactions/vendcred.nl',
  'returnauthorization': '/app/accounting/transactions/rtnauth.nl',
  'rtnauth': '/app/accounting/transactions/rtnauth.nl',
  'deposit': '/app/accounting/transactions/deposit.nl',
  'assemblybuild': '/app/accounting/transactions/build.nl',
  'itemfulfillment': '/app/accounting/transactions/itemfulfillment.nl',
  'itemfld': '/app/accounting/transactions/itemfulfillment.nl',
  'transferorder': '/app/accounting/transactions/trnfrord.nl',
  'expensereport': '/app/accounting/transactions/exprept.nl',
  'exprept': '/app/accounting/transactions/exprept.nl',
  'cashrefund': '/app/accounting/transactions/cashrfnd.nl',
  'cashrfnd': '/app/accounting/transactions/cashrfnd.nl',
  
  // Items
  'item': '/app/common/item/item.nl',
  'inventoryitem': '/app/common/item/item.nl',
  'noninventoryitem': '/app/common/item/item.nl',
  'serviceitem': '/app/common/item/item.nl',
  'kititem': '/app/common/item/item.nl',
  'assemblyitem': '/app/common/item/item.nl',
};

/**
 * Generate standard NetSuite browser deep link URL
 * @param accountId - NetSuite Account ID (e.g. 123456 or 123456_SB1)
 * @param recordType - Record type (e.g. salesorder, customer, customrecord_...)
 * @param recordId - Record internal ID
 * @param rectype - Optional numeric ID or script ID for custom record types
 * @returns Full URL to access record in the UI, or null if required params missing
 */
export function generateNetSuiteUrl(
  accountId: string | undefined,
  recordType: string | undefined,
  recordId: string | number | undefined,
  rectype?: number | string
): string | null {
  if (!accountId || !recordId) return null;

  // DNS-compliant formatting: replace underscores with hyphens, lowercase
  const formattedAccountId = accountId.toString().replace(/_/g, '-').toLowerCase();
  
  // Normalize record type (lowercase and remove spaces, underscores, hyphens)
  const normalizedType = recordType ? recordType.toLowerCase().replace(/[\s_-]/g, '') : '';
  const originalType = recordType ? recordType.toLowerCase().trim() : '';

  let urlPath = '';

  if (rectype) {
    urlPath = `/app/common/custom/custrecordentry.nl?rectype=${rectype}&id=${recordId}`;
  } else if (originalType.startsWith('customrecord')) {
    // Correctly resolve custom records using their text script ID as the rectype parameter
    urlPath = `/app/common/custom/custrecordentry.nl?rectype=${originalType}&id=${recordId}`;
  } else if (RECORD_URL_MAP[normalizedType]) {
    urlPath = `${RECORD_URL_MAP[normalizedType]}?id=${recordId}`;
  } else {
    // Fallback: transaction.nl automatically redirects standard transaction types
    urlPath = `/app/accounting/transactions/transaction.nl?id=${recordId}`;
  }

  return `https://${formattedAccountId}.app.netsuite.com${urlPath}`;
}
