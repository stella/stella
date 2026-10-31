import type { InvoiceStatus } from "@stll/api-contract";
import { parseLocaleMinorUnits } from "@stll/money";

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
  | { type: "invalid_format" }
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
  locale,
}: {
  input: string;
  currency: string;
  outstandingAmount: number;
  locale: string;
}): PaymentAmountCheck => {
  const parsed = parseLocaleMinorUnits({ amount: input, currency, locale });
  if (parsed.isErr()) {
    return parsed.error.reason === "empty"
      ? { type: "not_positive" }
      : { type: "invalid_format" };
  }
  if (parsed.value <= 0) {
    return { type: "not_positive" };
  }
  const amount = parsed.value;
  return amount > outstandingAmount
    ? { type: "more_than_outstanding" }
    : { type: "ok", amount };
};
