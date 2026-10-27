import type { InvoiceStatus } from "@stll/api-contract";
import { tryToMinorUnits } from "@stll/money";

/**
 * An issued invoice takes payments while it is finalized or sent (firms often
 * send invoices outside stella); paid follows from the payments.
 */
export const invoiceTakesPayments = (status: InvoiceStatus) =>
  status === "finalized" || status === "sent";

/** An issued invoice with payments that do not yet settle it. */
export const isPartiallyPaid = (invoice: {
  status: InvoiceStatus;
  paidAmount: number;
}) => invoiceTakesPayments(invoice.status) && invoice.paidAmount > 0;

type PaymentAmountCheck =
  | { type: "ok"; amount: number }
  | { type: "not_positive" }
  | { type: "more_than_outstanding" };

/**
 * The payment a person typed, in minor units of the invoice's currency: a
 * positive amount no larger than what the invoice still owes. The server
 * refuses the same overpayment under the invoice lock; this only answers
 * beside the field before a request is sent.
 */
export const checkPaymentAmount = ({
  input,
  currency,
  outstandingAmount,
}: {
  input: string;
  currency: string;
  outstandingAmount: number;
}): PaymentAmountCheck => {
  const amount = tryToMinorUnits({ amount: input, currency });
  if (amount === null || amount <= 0) {
    return { type: "not_positive" };
  }
  return amount > outstandingAmount
    ? { type: "more_than_outstanding" }
    : { type: "ok", amount };
};
