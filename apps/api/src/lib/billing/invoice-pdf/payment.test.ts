import { expect, test } from "bun:test";

import { cents } from "@stll/money";

import { invoicePaymentAmounts } from "../invoice-payments";
import { assertInvoicePaymentRequest } from "./payment.test-helpers";
import { buildInvoicePaymentPayload } from "./render-helpers";
import { buildInvoiceTemplateData } from "./typst/data";
import { invoiceFixture } from "./typst/fixtures";

for (const paidAmount of [0, 300_000, 756_250]) {
  test(`PDF payment details and QR follow the balance after ${paidAmount} paid`, () => {
    const invoice = invoiceFixture(1);
    const { outstandingAmount } = invoicePaymentAmounts({
      totalAmount: invoice.totals.grossAmountMinor,
      paidAmount,
    });
    assertInvoicePaymentRequest({
      invoice: { ...invoice, paymentAmountMinor: outstandingAmount },
      grossAmountMinor: 756_250,
      outstandingAmount,
    });
  });
}

test("an unpaid credit note with a seller account requests no payment", () => {
  const fixture = invoiceFixture(1);
  const { outstandingAmount } = invoicePaymentAmounts({
    totalAmount: cents(-756_250),
    paidAmount: 0,
  });
  // The balance of an unpaid credit note is positive; the document type alone
  // must keep its payment block and QR code out.
  expect(outstandingAmount).toBeGreaterThan(0);
  const credit = {
    ...fixture,
    originalNumber: "2026-ORIGINAL",
    invoice: {
      ...fixture.invoice,
      documentType: "credit_note" as const,
      invoiceNumber: "2026-CREDIT",
    },
    totals: { ...fixture.totals, grossAmountMinor: cents(-756_250) },
    paymentAmountMinor: outstandingAmount,
  };
  expect(credit.seller?.iban).toBeTruthy();
  expect(buildInvoiceTemplateData(credit).unwrap().payment).toBeNull();
  expect(buildInvoicePaymentPayload(credit)).toBeNull();
});
