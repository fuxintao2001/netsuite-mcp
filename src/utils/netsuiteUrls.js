const RECORD_URL_MAP = {
  // Entities
  'customer': '/app/common/entity/custjob.nl',
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
  
  // Transactions (Direct URL paths)
  'salesorder': '/app/accounting/transactions/salesord.nl',
  'invoice': '/app/accounting/transactions/custinvc.nl',
  'purchaseorder': '/app/accounting/transactions/purchord.nl',
  'vendorbill': '/app/accounting/transactions/vendbill.nl',
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
  'transferorder': '/app/accounting/transactions/trnfrord.nl',
  'expensereport': '/app/accounting/transactions/exprept.nl',
  'cashrefund': '/app/accounting/transactions/cashrfnd.nl',
  
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
 * @param {string} accountId - NetSuite Account ID (e.g. 123456 or 123456_SB1)
 * @param {string} recordType - Record type (e.g. salesorder, customer, customrecord_...)
 * @param {string|number} recordId - Record internal ID
 * @param {number} [rectype] - Optional numeric ID for custom record types
 * @returns {string|null} Full URL to access record in the UI
 */
export function generateNetSuiteUrl(accountId, recordType, recordId, rectype) {
  if (!accountId || !recordId) return null;

  // DNS-compliant formatting: replace underscores with hyphens, lowercase
  const formattedAccountId = accountId.toString().replace(/_/g, '-').toLowerCase();
  const lowerType = recordType ? recordType.toLowerCase() : '';

  let path = '';

  if (rectype) {
    path = `/app/common/custom/custrecordentry.nl?rectype=${rectype}&id=${recordId}`;
  } else if (lowerType.startsWith('customrecord')) {
    // If it's a custom record type but no rectype ID is given, fallback to transaction resolving 
    // or entity path if the user wants. We'll default to transaction.nl which sometimes redirects or fails gracefully.
    path = `/app/accounting/transactions/transaction.nl?id=${recordId}`;
  } else if (RECORD_URL_MAP[lowerType]) {
    path = `${RECORD_URL_MAP[lowerType]}?id=${recordId}`;
  } else {
    // Fallback: transaction.nl automatically redirects standard transaction types
    path = `/app/accounting/transactions/transaction.nl?id=${recordId}`;
  }

  return `https://${formattedAccountId}.app.netsuite.com${path}`;
}
