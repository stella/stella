import { panic } from "better-result";

import type { InvoiceDocumentType } from "@stll/invoicing";
import { cents, type CentsAmount } from "@stll/money";

import { INVOICE_STATUS, type InvoiceStatus } from "@/api/db/schema";

/**
 * What a document settles: the amount owed on an invoice, the refund owed on
 * a credit note (whose total is negative). Payments are always positive.
 */
const payableAmount = (totalAmount: number) => Math.abs(totalAmount);

declare const amountDueBrand: unique symbol;

/**
 * What a client may still pay on a document: its payable total less the
 * credit notes issued against it and the payments recorded on it. Only
 * `invoiceAmountDue` makes one, so every client-facing payment request (the
 * PDF payment block, the link page with its QR code, the email) states the
 * amount `invoicePaymentAmounts` reports as outstanding, never the total.
 */
export type AmountDue = CentsAmount & { readonly [amountDueBrand]: true };

const isAmountDue = (_amount: CentsAmount): _amount is AmountDue => true;

type InvoiceBalanceInput = {
  totalAmount: number;
  paidAmount: number;
  /**
   * What issued credit notes take off the original
   * (`invoiceCreditedAmountSql`); a credit note is never credited itself.
   */
  creditedAmount: number;
};

const outstandingOf = ({
  totalAmount,
  paidAmount,
  creditedAmount,
}: InvoiceBalanceInput) =>
  cents(Math.max(0, payableAmount(totalAmount) - creditedAmount - paidAmount));

/** The amount a client may still pay, for documents and messages sent to them. */
export const invoiceAmountDue = (balance: InvoiceBalanceInput): AmountDue => {
  const outstanding = outstandingOf(balance);
  return isAmountDue(outstanding)
    ? outstanding
    : panic("Outstanding amounts are amounts due");
};

/** The plain minor-unit amount of an amount due, for API responses. */
export const amountDueCents = (amount: AmountDue): CentsAmount => amount;

/**
 * How an issued document stands, from its payments and the credit notes
 * issued against it. Only payments make it `paid`: a document its credit
 * notes cover alone is `credited`, with no payment and no payment date, so a
 * credit can never be counted, exported or shown as money received.
 * `overpaid` is a document whose payments exceed what the credit notes leave
 * of it; the client is owed `refundAmount`.
 */
export type InvoiceSettlement =
  | { kind: "open" }
  | { kind: "paid" }
  | { kind: "credited" }
  | { kind: "overpaid"; refundAmount: CentsAmount };

type InvoiceSettlementInput = InvoiceBalanceInput & { status: InvoiceStatus };

/** The settlement of one document; see `InvoiceSettlement`. */
export const invoiceSettlement = ({
  totalAmount,
  paidAmount,
  creditedAmount,
  status,
}: InvoiceSettlementInput): InvoiceSettlement => {
  const payable = payableAmount(totalAmount);
  const remaining = Math.max(0, payable - creditedAmount);
  if (paidAmount > remaining) {
    return { kind: "overpaid", refundAmount: cents(paidAmount - remaining) };
  }
  if (
    status === INVOICE_STATUS.PAID &&
    paidAmount === 0 &&
    creditedAmount === 0
  ) {
    // Settled without a payment row: a zero document once sent, or one
    // marked paid before payments were recorded (until its backfill).
    return { kind: "paid" };
  }
  if (payable === 0) {
    return { kind: "open" };
  }
  if (remaining === 0) {
    return { kind: "credited" };
  }
  return paidAmount === remaining ? { kind: "paid" } : { kind: "open" };
};

/** The paid and outstanding amounts and the settlement an invoice read exposes. */
export const invoicePaymentAmounts = (balance: InvoiceSettlementInput) => ({
  paidAmount: cents(balance.paidAmount),
  outstandingAmount: outstandingOf(balance),
  settlement: invoiceSettlement(balance),
});

/**
 * Whether payments settle a document in this status: they cover what its
 * issued credit notes leave of a nonzero total (a credit alone never settles
 * it), while a zero total owes nothing yet counts as settled only once the
 * invoice was sent (or is already paid), never merely by being issued.
 */
export const isInvoiceSettled = ({
  totalAmount,
  paidAmount,
  creditedAmount,
  status,
}: InvoiceSettlementInput) =>
  totalAmount === 0
    ? status === INVOICE_STATUS.SENT || status === INVOICE_STATUS.PAID
    : paidAmount > 0 &&
      paidAmount >= Math.max(0, payableAmount(totalAmount) - creditedAmount);

export type InvoicePaymentState =
  | { status: "not_payable" }
  | { status: "settled" }
  | { status: "due"; amountMinor: AmountDue };

/**
 * What a document states about payment: the amount still due after its
 * payments and issued credit notes, settled by the same rule as the
 * invoice's status. Nothing outstanding on an unsettled document (a zero
 * total not yet sent, an invoice its credit notes cover) states nothing.
 */
export const invoicePaymentState = (
  balance: InvoiceSettlementInput & { documentType: InvoiceDocumentType },
): InvoicePaymentState => {
  if (balance.documentType === "credit_note") {
    return { status: "not_payable" };
  }
  const amountDue = invoiceAmountDue(balance);
  if (amountDue > 0) {
    return { status: "due", amountMinor: amountDue };
  }
  return isInvoiceSettled(balance)
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
