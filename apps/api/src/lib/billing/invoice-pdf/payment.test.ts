import { expect, test } from "bun:test";

import { cents } from "@stll/money";

import { invoiceAmountDue, invoicePaymentAmounts } from "../invoice-payments";
import { assertInvoicePaymentRequest } from "./payment.test-helpers";
import { buildInvoicePaymentPayload } from "./render-helpers";
import { buildInvoiceTemplateData } from "./typst/data";
import { invoiceFixture } from "./typst/fixtures";

const balances = [
  { paidAmount: 0, creditedAmount: 0, due: 756_250 },
  { paidAmount: 300_000, creditedAmount: 0, due: 456_250 },
  { paidAmount: 756_250, creditedAmount: 0, due: 0 },
  // Partially credited: the payment request asks for what the credit leaves.
  { paidAmount: 0, creditedAmount: 256_250, due: 500_000 },
  // Credited in full: nothing is due and no payment is requested.
  { paidAmount: 0, creditedAmount: 756_250, due: 0 },
  // Credited after a partial payment: payment and credit together settle it.
  { paidAmount: 300_000, creditedAmount: 456_250, due: 0 },
  { paidAmount: 300_000, creditedAmount: 200_000, due: 256_250 },
] as const;

for (const { paidAmount, creditedAmount, due } of balances) {
  test(`PDF payment details and QR ask for ${due} after ${paidAmount} paid and ${creditedAmount} credited`, () => {
    const invoice = invoiceFixture(1);
    const balance = {
      totalAmount: invoice.totals.grossAmountMinor,
      paidAmount,
      creditedAmount,
      status: "sent",
    } as const;
    const amountDue = invoiceAmountDue(balance);
    // The read projection and the client-facing amount are one computation.
    expect<number>(amountDue).toBe(
      invoicePaymentAmounts(balance).outstandingAmount,
    );
    expect<number>(amountDue).toBe(due);
    assertInvoicePaymentRequest({
      invoice: { ...invoice, paymentAmountMinor: amountDue },
      grossAmountMinor: 756_250,
      outstandingAmount: due,
    });
  });
}

test("an unpaid credit note with a seller account requests no payment", () => {
  const fixture = invoiceFixture(1);
  const amountDue = invoiceAmountDue({
    totalAmount: cents(-756_250),
    paidAmount: 0,
    creditedAmount: 0,
  });
  // The balance of an unpaid credit note is positive; the document type alone
  // must keep its payment block and QR code out.
  expect(amountDue).toBeGreaterThan(0);
  const credit = {
    ...fixture,
    originalNumber: "2026-ORIGINAL",
    invoice: {
      ...fixture.invoice,
      documentType: "credit_note" as const,
      invoiceNumber: "2026-CREDIT",
    },
    totals: { ...fixture.totals, grossAmountMinor: cents(-756_250) },
    paymentAmountMinor: amountDue,
  };
  expect(credit.seller.iban).toBeTruthy();
  expect(buildInvoiceTemplateData(credit).unwrap().payment).toBeNull();
  expect(buildInvoicePaymentPayload(credit)).toBeNull();
});
