export const TIME_ENTRY_STATUSES = [
  "draft",
  "approved",
  "billed",
  "written_off",
] as const;

export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];

export const BILLING_STATUS = {
  DRAFT: TIME_ENTRY_STATUSES[0],
  APPROVED: TIME_ENTRY_STATUSES[1],
  BILLED: TIME_ENTRY_STATUSES[2],
  WRITTEN_OFF: TIME_ENTRY_STATUSES[3],
} as const satisfies Record<string, TimeEntryStatus>;

type MissingBillingStatus = Exclude<
  TimeEntryStatus,
  (typeof BILLING_STATUS)[keyof typeof BILLING_STATUS]
>;

true satisfies MissingBillingStatus extends never ? true : never;

export const EXPENSE_CATEGORIES = [
  "filing_fee",
  "expert_witness",
  "travel",
  "printing",
  "courier",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const TIME_ENTRY_SOURCES = ["manual", "timer"] as const;

export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

export const TIME_ENTRY_SOURCE = {
  MANUAL: TIME_ENTRY_SOURCES[0],
  TIMER: TIME_ENTRY_SOURCES[1],
} as const satisfies Record<string, TimeEntrySource>;

type MissingTimeEntrySource = Exclude<
  TimeEntrySource,
  (typeof TIME_ENTRY_SOURCE)[keyof typeof TIME_ENTRY_SOURCE]
>;

true satisfies MissingTimeEntrySource extends never ? true : never;

export const INVOICE_STATUSES = [
  "draft",
  "finalized",
  "sent",
  "paid",
  "void",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS = {
  DRAFT: INVOICE_STATUSES[0],
  FINALIZED: INVOICE_STATUSES[1],
  SENT: INVOICE_STATUSES[2],
  PAID: INVOICE_STATUSES[3],
  VOID: INVOICE_STATUSES[4],
} as const satisfies Record<string, InvoiceStatus>;

type MissingInvoiceStatus = Exclude<
  InvoiceStatus,
  (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS]
>;

true satisfies MissingInvoiceStatus extends never ? true : never;
