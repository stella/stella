export const TIME_ENTRY_ACTIVITY_GROUPS = ["client", "internal"] as const;
export type TimeEntryActivityGroup =
  (typeof TIME_ENTRY_ACTIVITY_GROUPS)[number];
export const TIME_ENTRY_ACTIVITY_GROUP = {
  CLIENT: "client",
  INTERNAL: "internal",
} as const satisfies Record<string, TimeEntryActivityGroup>;

type MissingTimeEntryActivityGroup = Exclude<
  TimeEntryActivityGroup,
  (typeof TIME_ENTRY_ACTIVITY_GROUP)[keyof typeof TIME_ENTRY_ACTIVITY_GROUP]
>;
true satisfies MissingTimeEntryActivityGroup extends never ? true : never;

/** ISO 4217 code for an entry whose financial value has not been configured. */
export const UNPRICED_TIME_ENTRY_CURRENCY = "XXX";

/**
 * An entry's review lifecycle: a timekeeper's draft is submitted for review,
 * approved (or returned to draft with a reason), then billed or written off.
 */
export const TIME_ENTRY_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "billed",
  "written_off",
] as const;

export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];

export const BILLING_STATUS = {
  DRAFT: "draft",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  BILLED: "billed",
  WRITTEN_OFF: "written_off",
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

/** What one emailed invoice send may carry. */
export const INVOICE_SEND_LIMITS = {
  minRecipients: 1,
  maxRecipients: 10,
  messageMaxChars: 2000,
} as const;

/** Languages in which Stella can render an invoice document. */
export const INVOICE_LANGUAGES = [
  "ar",
  "cs",
  "de",
  "en",
  "es",
  "et",
  "fr",
  "hu",
  "lt",
  "lv",
  "pl",
  "pt-BR",
  "sk",
] as const;
export type InvoiceLanguage = (typeof INVOICE_LANGUAGES)[number];

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const TIME_ENTRY_SOURCES = [
  "manual",
  "timer",
  "suggested",
  "activity",
] as const;

export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

export const TIME_ENTRY_SOURCE = {
  MANUAL: "manual",
  TIMER: "timer",
  SUGGESTED: "suggested",
  ACTIVITY: "activity",
} as const satisfies Record<string, TimeEntrySource>;

type MissingTimeEntrySource = Exclude<
  TimeEntrySource,
  (typeof TIME_ENTRY_SOURCE)[keyof typeof TIME_ENTRY_SOURCE]
>;

true satisfies MissingTimeEntrySource extends never ? true : never;

/**
 * What the timekeeper did with a suggested entry. A suggestion that was not
 * acted on has no row: it is recomputed from activity on every read.
 */
export const TIME_ENTRY_SUGGESTION_STATUSES = [
  "accepted",
  "dismissed",
] as const;

export type TimeEntrySuggestionStatus =
  (typeof TIME_ENTRY_SUGGESTION_STATUSES)[number];

export const TIME_ENTRY_SUGGESTION_STATUS = {
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
} as const satisfies Record<string, TimeEntrySuggestionStatus>;

type MissingTimeEntrySuggestionStatus = Exclude<
  TimeEntrySuggestionStatus,
  (typeof TIME_ENTRY_SUGGESTION_STATUS)[keyof typeof TIME_ENTRY_SUGGESTION_STATUS]
>;

true satisfies MissingTimeEntrySuggestionStatus extends never ? true : never;

export const NUMBER_SERIES_DOCUMENT_TYPES = [
  "invoice",
  "advance",
  "credit_note",
] as const;

export const INVOICE_STATUSES = [
  "draft",
  "finalized",
  "sent",
  "paid",
  "void",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS = {
  DRAFT: "draft",
  FINALIZED: "finalized",
  SENT: "sent",
  PAID: "paid",
  VOID: "void",
} as const satisfies Record<string, InvoiceStatus>;

type MissingInvoiceStatus = Exclude<
  InvoiceStatus,
  (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS]
>;

true satisfies MissingInvoiceStatus extends never ? true : never;

/** Where an invoice line's amount comes from. */
export const INVOICE_LINE_SOURCES = [
  "manual",
  "time_entry",
  "expense",
] as const;

export type InvoiceLineSource = (typeof INVOICE_LINE_SOURCES)[number];

export const INVOICE_LINE_SOURCE = {
  MANUAL: "manual",
  TIME_ENTRY: "time_entry",
  EXPENSE: "expense",
} as const satisfies Record<string, InvoiceLineSource>;

type MissingInvoiceLineSource = Exclude<
  InvoiceLineSource,
  (typeof INVOICE_LINE_SOURCE)[keyof typeof INVOICE_LINE_SOURCE]
>;

true satisfies MissingInvoiceLineSource extends never ? true : never;

/** How a client settled (part of) an invoice. */
export const INVOICE_PAYMENT_METHODS = [
  "bank_transfer",
  "card",
  "cash",
  "other",
] as const;

export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];

/** Persisted payment text bounds shared by HTTP schemas and the payment form. */
export const INVOICE_PAYMENT_INPUT_LIMITS = {
  referenceMaxChars: 140,
  noteMaxChars: 1000,
} as const;

/** Payment terms the invoice composer offers as one-click choices. */
export const INVOICE_DUE_DAY_PRESETS = [7, 14, 30] as const;

/** Payment term used when neither the client nor the caller sets one. */
export const DEFAULT_INVOICE_DUE_DAYS = 14;

/** Persisted invoice-line input bounds shared by HTTP schemas and bill editors. */
export const INVOICE_LINE_INPUT_LIMITS = {
  descriptionMinChars: 1,
  descriptionMaxChars: 10_000,
  quantityPrecision: 18,
  quantityScale: 4,
  unitMaxChars: 32,
  unitPriceMinMinor: 0,
} as const;

export const INVOICE_LINE_QUANTITY_PATTERN = `^(0|[1-9][0-9]{0,${INVOICE_LINE_INPUT_LIMITS.quantityPrecision - INVOICE_LINE_INPUT_LIMITS.quantityScale - 1}})(\\.[0-9]{1,${INVOICE_LINE_INPUT_LIMITS.quantityScale}})?$`;
