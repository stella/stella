import type { InvoiceDocumentType } from "@stll/invoicing";
import { cents, type CentsAmount } from "@stll/money";

/**
 * What a document settles: the amount owed on an invoice, the refund owed on
 * a credit note (whose total is negative). Payments are always positive.
 */
export const payableAmount = (totalAmount: number) => Math.abs(totalAmount);

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

export type InvoicePaymentState =
  | { status: "not_payable" }
  | { status: "settled" }
  | { status: "due"; amountMinor: CentsAmount };

/** Payment instructions use the ledger balance, independently of document totals. */
export const invoicePaymentState = (
  amounts: Parameters<typeof invoicePaymentAmounts>[0] & {
    documentType: InvoiceDocumentType;
  },
): InvoicePaymentState => {
  if (amounts.documentType === "credit_note") {
    return { status: "not_payable" };
  }
  const { outstandingAmount } = invoicePaymentAmounts(amounts);
  return outstandingAmount === 0
    ? { status: "settled" }
    : { status: "due", amountMinor: cents(outstandingAmount) };
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
