import { panic } from "better-result";
import { expect } from "bun:test";

import { buildCzechQrPaymentPayload, variableSymbolOf } from "@stll/invoicing";
import { cents } from "@stll/money";

import {
  buildInvoicePaymentPayload,
  createInvoiceFormatters,
} from "./render-helpers";
import type { RenderInvoicePdfOptions } from "./render-helpers";
import { buildInvoiceTemplateData, qrSvg } from "./typst/data";

type AssertInvoicePaymentRequestOptions = {
  invoice: RenderInvoicePdfOptions;
  grossAmountMinor: number;
  outstandingAmount: number;
};

/** Check the final template fields and encoded QR against the payment snapshot. */
export const assertInvoicePaymentRequest = ({
  invoice,
  grossAmountMinor,
  outstandingAmount,
}: AssertInvoicePaymentRequestOptions) => {
  expect(invoice.paymentAmountMinor).toBe(cents(outstandingAmount));
  expect(invoice.totals.grossAmountMinor).toBe(cents(grossAmountMinor));
  const data = buildInvoiceTemplateData(invoice).unwrap();
  expect(data.seller?.name).toBe(invoice.seller?.legalName);
  const { money } = createInvoiceFormatters({
    currency: invoice.invoice.currency,
    locale: invoice.invoice.language,
  });
  expect(data.totals.grossMinor).toBe(cents(grossAmountMinor));
  expect(data.totals.gross).toBe(money(grossAmountMinor));
  if (outstandingAmount === 0) {
    expect(data.payment).toBeNull();
    expect(buildInvoicePaymentPayload(invoice)).toBeNull();
    return;
  }
  const variableSymbol = variableSymbolOf({
    number: invoice.invoice.invoiceNumber ?? "",
    reference: invoice.invoice.reference,
  });
  const payload = buildCzechQrPaymentPayload({
    documentType: invoice.invoice.documentType,
    iban: invoice.seller?.iban ?? panic("Payment fixture needs an IBAN"),
    amountMinor: cents(outstandingAmount),
    currency: invoice.invoice.currency,
    ...(invoice.invoice.dueDate === null
      ? {}
      : { dueDate: invoice.invoice.dueDate }),
    ...(variableSymbol === null ? {} : { variableSymbol }),
    ...(invoice.invoice.status === "draft" ||
    invoice.invoice.invoiceNumber === null
      ? {}
      : { message: invoice.invoice.invoiceNumber }),
  }).unwrap();
  if (payload.status !== "payable") {
    panic("Payment fixture must support Czech QR payments");
  }
  expect(data.payment).toMatchObject({
    fields: expect.arrayContaining([
      { label: expect.any(String), value: money(outstandingAmount) },
    ]),
    qrSvg: qrSvg(payload.payload, "M"),
  });
};
