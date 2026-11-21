import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { InvoiceDocumentType } from "@stll/invoicing";
import { assertProperty } from "@stll/property-testing";

import { INVOICE_STATUS, type InvoiceStatus } from "@/api/db/schema";

import {
  amountDueCents,
  invoiceAmountDue,
  invoicePaymentAmounts,
  invoicePaymentState,
  invoiceSettlement,
  isInvoiceSettled,
  paidAmountOf,
} from "./invoice-payment-amounts";

const ALL_INVOICE_STATUSES: InvoiceStatus[] = [
  INVOICE_STATUS.DRAFT,
  INVOICE_STATUS.ISSUED,
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.PAID,
  INVOICE_STATUS.OVERDUE,
  INVOICE_STATUS.CANCELLED,
];
const statusArb = fc.constantFrom(...ALL_INVOICE_STATUSES);
const documentTypeArb = fc.constantFrom<InvoiceDocumentType>(
  "invoice",
  "credit_note",
);
const totalAmountArb = fc.integer({ min: -10_000_000, max: 10_000_000 });
const nonNegativeCentsArb = fc.integer({ min: 0, max: 10_000_000 });

describe("invoice payment amounts properties", () => {
  test("conservation law: payable, credited, paid, outstanding, and refund always reconcile", () => {
    assertProperty(
      "conservation law: payable, credited, paid, outstanding, and refund always reconcile",
      fc.property(
        totalAmountArb,
        nonNegativeCentsArb,
        nonNegativeCentsArb,
        statusArb,
        (totalAmount, paidAmount, creditedAmount, status) => {
          const balance = { totalAmount, paidAmount, creditedAmount, status };
          const payable = Math.abs(totalAmount);
          const remaining = Math.max(0, payable - creditedAmount);
          const result = invoicePaymentAmounts(balance);
          const amountDue = amountDueCents(invoiceAmountDue(balance));

          expect(result.outstandingAmount).toBe(amountDue);
          expect(result.paidAmount).toBe(paidAmount);
          expect(amountDue).toBeGreaterThanOrEqual(0);
          expect(amountDue).toBe(Math.max(0, remaining - paidAmount));

          if (paidAmount > remaining) {
            expect(result.settlement).toEqual({
              kind: "overpaid",
              refundAmount: paidAmount - remaining,
            });
            expect(amountDue).toBe(0);
          } else {
            expect(result.settlement.kind).not.toBe("overpaid");
            expect(amountDue + paidAmount).toBe(remaining);
          }
        },
      ),
    );
  });

  test("credit notes alone never mark a nonzero invoice as paid or settled", () => {
    assertProperty(
      "credit notes alone never mark a nonzero invoice as paid or settled",
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        statusArb,
        (absTotal, extraCredit, status) => {
          const creditedAmount = absTotal + extraCredit;
          const balance = {
            totalAmount: absTotal,
            paidAmount: 0,
            creditedAmount,
            status,
          };
          expect(invoiceSettlement(balance)).toEqual({ kind: "credited" });
          expect(isInvoiceSettled(balance)).toBe(false);
          expect(amountDueCents(invoiceAmountDue(balance))).toBe(0);
          expect(
            invoicePaymentState({ ...balance, documentType: "invoice" }),
          ).toEqual({ status: "not_payable" });
        },
      ),
    );
  });

  test("monotonicity: adding payments or credits never increases amount due", () => {
    assertProperty(
      "monotonicity: adding payments or credits never increases amount due",
      fc.property(
        totalAmountArb,
        nonNegativeCentsArb,
        nonNegativeCentsArb,
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (totalAmount, paidAmount, creditedAmount, deltaPaid, deltaCredited) => {
          const before = amountDueCents(
            invoiceAmountDue({ totalAmount, paidAmount, creditedAmount }),
          );
          const after = amountDueCents(
            invoiceAmountDue({
              totalAmount,
              paidAmount: paidAmount + deltaPaid,
              creditedAmount: creditedAmount + deltaCredited,
            }),
          );
          expect(after).toBeLessThanOrEqual(before);
        },
      ),
    );
  });

  test("credit notes are never payable and due invoices always carry positive amountMinor", () => {
    assertProperty(
      "credit notes are never payable and due invoices always carry positive amountMinor",
      fc.property(
        totalAmountArb,
        nonNegativeCentsArb,
        nonNegativeCentsArb,
        statusArb,
        documentTypeArb,
        (totalAmount, paidAmount, creditedAmount, status, documentType) => {
          const state = invoicePaymentState({
            totalAmount,
            paidAmount,
            creditedAmount,
            status,
            documentType,
          });
          if (documentType === "credit_note") {
            expect(state).toEqual({ status: "not_payable" });
            return;
          }
          const due = amountDueCents(
            invoiceAmountDue({ totalAmount, paidAmount, creditedAmount }),
          );
          if (due > 0) {
            expect(state).toEqual({ status: "due", amountMinor: due });
          } else if (
            isInvoiceSettled({
              totalAmount,
              paidAmount,
              creditedAmount,
              status,
            })
          ) {
            expect(state).toEqual({ status: "settled" });
          } else {
            expect(state).toEqual({ status: "not_payable" });
          }
        },
      ),
    );
  });

  test("paidAmountOf ignores voided payments and is invariant under permutation", () => {
    assertProperty(
      "paidAmountOf ignores voided payments and is invariant under permutation",
      fc.property(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 0, max: 1_000_000 }),
            voided: fc.boolean(),
          }),
          { maxLength: 25 },
        ),
        (items) => {
          const payments = items.map((item, idx) => ({
            amount: item.amount,
            voidedAt: item.voided
              ? new Date(1_700_000_000_000 + idx * 1000)
              : null,
          }));
          const reversed = payments.toReversed();
          const expected = items.reduce(
            (sum, item) => sum + (item.voided ? 0 : item.amount),
            0,
          );
          expect(paidAmountOf(payments)).toBe(expected);
          expect(paidAmountOf(reversed)).toBe(expected);
        },
      ),
    );
  });
});
