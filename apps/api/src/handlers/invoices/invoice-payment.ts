import { Result } from "better-result";
import { type Static, t } from "elysia";

import { parsePlainDate } from "@stll/time";

import { INVOICE_STATUS, type invoices } from "@/api/db/schema";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { tMinorUnitAmount } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

export const tMarkInvoicePaid = t.Object(
  {
    action: t.Literal("mark_paid"),
    paidDate: t.Optional(t.String({ format: "date" })),
    paidAmountMinor: t.Optional(tMinorUnitAmount(0)),
    note: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
    reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  },
  { additionalProperties: false },
);
export const tUndoInvoicePaid = t.Object(
  { action: t.Literal("undo_paid") },
  { additionalProperties: false },
);

const PAYMENT_ERROR = {
  DATE: "payment_date_invalid",
  CREDIT_NOTE: "credit_note_payment_unsupported",
  AMOUNT: "partial_payment_not_supported",
  AUTHORIZATION: "payment_undo_forbidden",
  REPLAY: "payment_details_conflict",
} as const;
const PAYMENT_ERRORS = {
  [PAYMENT_ERROR.DATE]: {
    status: 400,
    message: "Payment date must be a real ISO calendar day",
    hint: "Retry invoices.transition with action mark_paid and paidDate in YYYY-MM-DD format, or omit paidDate to use UTC today.",
  },
  [PAYMENT_ERROR.CREDIT_NOTE]: {
    status: 409,
    message: "Credit notes cannot record a client payment",
    hint: "Use list_invoices with invoice_id to inspect the credit note and its original invoice; this release has no refund or settlement action.",
  },
  [PAYMENT_ERROR.AMOUNT]: {
    status: 409,
    message:
      "The payment must equal the full invoice total; partial payments and overpayments are not supported",
    hint: "Read list_invoices with invoice_id, then call invoices.transition with action mark_paid and paidAmountMinor equal to totalAmount, or omit the amount.",
  },
  [PAYMENT_ERROR.AUTHORIZATION]: {
    status: 403,
    message: "Only organization owners and administrators may undo a payment",
    hint: "Ask an organization owner or administrator to call invoices.transition with action undo_paid for this invoice.",
  },
  [PAYMENT_ERROR.REPLAY]: {
    status: 409,
    message: "This invoice already has different payment details",
    hint: "Read list_invoices with invoice_id. To correct payment details, an owner or administrator must call invoices.transition with action undo_paid, then mark_paid with the corrected details.",
  },
} as const satisfies Record<
  (typeof PAYMENT_ERROR)[keyof typeof PAYMENT_ERROR],
  { status: 400 | 403 | 409; message: string; hint: string }
>;
const paymentRefusal = (code: keyof typeof PAYMENT_ERRORS) =>
  new HandlerError({ code, ...PAYMENT_ERRORS[code] });

export const EMPTY_INVOICE_PAYMENT = {
  paidAt: null,
  paidDate: null,
  paidAmount: null,
  paymentNote: null,
  paymentReference: null,
} as const;
type PaymentFields = Pick<
  typeof invoices.$inferSelect,
  keyof typeof EMPTY_INVOICE_PAYMENT
>;
type PaymentInvoice = PaymentFields &
  Pick<typeof invoices.$inferSelect, "status" | "documentType" | "totalAmount">;
type PrepareInvoicePaymentOptions = {
  invoice: PaymentInvoice;
  body: Static<typeof tMarkInvoicePaid> | Static<typeof tUndoInvoicePaid>;
  memberRole: AuthorizedMemberRole;
  now: Date;
};
export const prepareInvoicePayment = ({
  invoice,
  body,
  memberRole,
  now,
}: PrepareInvoicePaymentOptions) => {
  if (body.action === "undo_paid") {
    if (memberRole.role !== "owner" && memberRole.role !== "admin") {
      return Result.err(paymentRefusal(PAYMENT_ERROR.AUTHORIZATION));
    }
    if (invoice.status === INVOICE_STATUS.SENT) {
      return Result.ok({ type: "replay" } as const);
    }
    return Result.ok({
      type: "update",
      fields: EMPTY_INVOICE_PAYMENT,
    } as const);
  }
  if (invoice.documentType === "credit_note") {
    return Result.err(paymentRefusal(PAYMENT_ERROR.CREDIT_NOTE));
  }
  const amount =
    body.paidAmountMinor === undefined
      ? invoice.totalAmount
      : cents(body.paidAmountMinor);
  if (amount !== invoice.totalAmount) {
    return Result.err(paymentRefusal(PAYMENT_ERROR.AMOUNT));
  }
  const alreadyPaid = invoice.status === INVOICE_STATUS.PAID;
  const recordedDate =
    invoice.paidDate ?? invoice.paidAt?.toISOString().slice(0, 10) ?? null;
  const recordedAmount = invoice.paidAmount ?? invoice.totalAmount;
  const paidDate =
    body.paidDate ??
    (alreadyPaid ? recordedDate : now.toISOString().slice(0, 10));
  if (paidDate === null) {
    return Result.err(paymentRefusal(PAYMENT_ERROR.REPLAY));
  }
  const calendarDate = parsePlainDate(paidDate);
  if (calendarDate === null || calendarDate.year < 1) {
    return Result.err(paymentRefusal(PAYMENT_ERROR.DATE));
  }
  const paymentNote =
    body.note === undefined && alreadyPaid
      ? invoice.paymentNote
      : body.note?.trim() || null;
  const paymentReference =
    body.reference === undefined && alreadyPaid
      ? invoice.paymentReference
      : body.reference?.trim() || null;
  if (alreadyPaid) {
    if (
      paidDate !== recordedDate ||
      amount !== recordedAmount ||
      paymentNote !== invoice.paymentNote ||
      paymentReference !== invoice.paymentReference
    ) {
      return Result.err(paymentRefusal(PAYMENT_ERROR.REPLAY));
    }
    return Result.ok({ type: "replay" } as const);
  }
  return Result.ok({
    type: "update",
    fields: {
      paidAt: now,
      paidDate,
      paidAmount: amount,
      paymentNote,
      paymentReference,
    },
  } as const);
};

export const invoicePaymentAuditChanges = (
  before: PaymentFields,
  after: Partial<PaymentFields>,
): FieldDiffs => {
  const changes: FieldDiffs = {};
  for (const field of [
    "paidAt",
    "paidDate",
    "paidAmount",
    "paymentNote",
    "paymentReference",
  ] as const) {
    const prior = before[field];
    const next = after[field] === undefined ? prior : after[field];
    const oldValue = prior instanceof Date ? prior.toISOString() : prior;
    const newValue = next instanceof Date ? next.toISOString() : next;
    if (oldValue !== newValue) {
      changes[field] = { old: oldValue, new: newValue };
    }
  }
  return changes;
};
