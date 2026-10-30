import { test } from "bun:test";

import { invoicePaymentAmounts } from "../invoice-payments";
import { assertInvoicePaymentRequest } from "./payment.test-helpers";
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
