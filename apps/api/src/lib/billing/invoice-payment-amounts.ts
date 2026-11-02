import type { InvoiceDocumentType } from "@stll/invoicing";
import { cents, type CentsAmount } from "@stll/money";

import { INVOICE_STATUS, type InvoiceStatus } from "@/api/db/schema";

/**
 * What a document settles: the amount owed on an invoice, the refund owed on
 * a credit note (whose total is negative). Payments are always positive.
 */
const payableAmount = (totalAmount: number) => Math.abs(totalAmount);

type PaymentAmounts = { paidAmount: number; outstandingAmount: number };

/** The paid and outstanding amounts an invoice read exposes. */
export const invoicePaymentAmounts = ({
  totalAmount,
  paidAmount,
}: {
  totalAmount: number;
  paidAmount: number;
}): PaymentAmounts => ({
  paidAmount,
  outstandingAmount: Math.max(0, payableAmount(totalAmount) - paidAmount),
});

/**
 * Whether the paid sum settles an invoice in this status. Payments cover a
 * nonzero total; a zero total owes nothing, yet it counts as settled only
 * once the invoice was sent (or is already paid), never merely by being
 * issued.
 */
export const isInvoiceSettled = ({
  totalAmount,
  paidAmount,
  status,
}: {
  totalAmount: number;
  paidAmount: number;
  status: InvoiceStatus;
}) =>
  paidAmount >= payableAmount(totalAmount) &&
  (totalAmount !== 0 ||
    status === INVOICE_STATUS.SENT ||
    status === INVOICE_STATUS.PAID);

export type InvoicePaymentState =
  | { status: "not_payable" }
  | { status: "settled" }
  | { status: "due"; amountMinor: CentsAmount };

/**
 * What a document states about payment: the ledger balance against the
 * total the document itself prints, settled by the same rule as the
 * invoice's status. Nothing outstanding on an unsettled invoice (a zero
 * total not yet sent) states nothing.
 */
export const invoicePaymentState = (
  amounts: Parameters<typeof invoicePaymentAmounts>[0] & {
    documentType: InvoiceDocumentType;
    status: InvoiceStatus;
  },
): InvoicePaymentState => {
  if (amounts.documentType === "credit_note") {
    return { status: "not_payable" };
  }
  const { outstandingAmount } = invoicePaymentAmounts(amounts);
  if (outstandingAmount > 0) {
    return { status: "due", amountMinor: cents(outstandingAmount) };
  }
  return isInvoiceSettled(amounts)
    ? { status: "settled" }
    : { status: "not_payable" };
};

/** The sum of the non-voided payments among an invoice's loaded payments. */
export const paidAmountOf = (
  payments: readonly { amount: number; voidedAt: Date | null }[],
) => {
  let paid = 0;
  for (const payment of payments) {
    if (payment.voidedAt === null) {
      paid += payment.amount;
    }
  }
  return paid;
};
