import { expect, test } from "bun:test";

import { cents } from "@stll/money";

import { INVOICE_STATUSES } from "@/api/db/schema";

import {
  invoicePaymentState,
  isInvoiceSettled,
} from "./invoice-payment-amounts";

test("a zero total is settled only once sent or paid, and states so only then", () => {
  const states = INVOICE_STATUSES.map((status) => [
    status,
    invoicePaymentState({
      documentType: "invoice",
      status,
      totalAmount: 0,
      paidAmount: 0,
    }),
  ]);
  expect(Object.fromEntries(states)).toEqual(
    Object.fromEntries(
      INVOICE_STATUSES.map((status) => [
        status,
        status === "sent" || status === "paid"
          ? { status: "settled" }
          : { status: "not_payable" },
      ]),
    ),
  );
});

test("the document state follows the same settled rule as the invoice status", () => {
  for (const status of INVOICE_STATUSES) {
    for (const [totalAmount, paidAmount] of [
      [0, 0],
      [100, 0],
      [100, 40],
      [100, 100],
      [100, 150],
    ] as const) {
      const state = invoicePaymentState({
        documentType: "invoice",
        status,
        totalAmount,
        paidAmount,
      });
      expect(state.status === "settled").toBe(
        isInvoiceSettled({ totalAmount, paidAmount, status }),
      );
      expect(state).toEqual(
        paidAmount < totalAmount
          ? { status: "due", amountMinor: cents(totalAmount - paidAmount) }
          : expect.anything(),
      );
    }
  }
});

test("a credit note asks for no payment whatever its balance", () => {
  expect(
    invoicePaymentState({
      documentType: "credit_note",
      status: "sent",
      totalAmount: -500,
      paidAmount: 0,
    }),
  ).toEqual({ status: "not_payable" });
});
