import { auditLogs, invoicePayments, invoiceSends } from "@/api/db/schema";

/** Historical identifiers survive both account deletion and membership removal. */
export const RETAINED_USER_ATTRIBUTION_COLUMNS = [
  {
    column: auditLogs.userId,
    reason:
      "Audit performer history; attribution grants no membership or authority.",
  },
  {
    column: invoicePayments.recordedBy,
    reason:
      "Billing payment attribution history; attribution grants no membership or authority.",
  },
  {
    column: invoicePayments.voidedBy,
    reason:
      "Billing payment reversal history; attribution grants no membership or authority.",
  },
  {
    column: invoiceSends.revokedByUserId,
    reason:
      "Invoice link revocation history; attribution grants no membership or authority.",
  },
] as const;
