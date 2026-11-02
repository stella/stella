import { expect, test } from "bun:test";
import fc from "fast-check";

import { buildPayBySquarePayload } from "@stll/invoicing/pay-by-square";
import { cents } from "@stll/money";
import { assertProperty } from "@stll/property-testing";

import {
  invoicePaymentState,
  paidAmountOf,
} from "@/api/lib/billing/invoice-payment-amounts";

import { buildInvoicePaymentPayload } from "./render-helpers";
import { buildInvoiceTemplateData } from "./typst/data";
import { invoiceFixture } from "./typst/fixtures";

const fixture = invoiceFixture(1);

test("payment sequences keep the QR equal to the nonnegative ledger balance", () => {
  assertProperty(
    "payment sequences keep the QR equal to the nonnegative ledger balance",
    fc.property(
      fc.constantFrom("invoice", "advance", "credit_note"),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.array(
        fc.record({
          action: fc.constantFrom("record", "void"),
          amount: fc.nat(1_000_000),
        }),
        { maxLength: 30 },
      ),
      (documentType, gross, actions) => {
        const total = documentType === "credit_note" ? -gross : gross;
        const payments: { amount: number; voidedAt: Date | null }[] = [];
        let remaining = gross;
        const check = () => {
          const settlement = invoicePaymentState({
            documentType,
            status: "sent",
            totalAmount: total,
            paidAmount: paidAmountOf(payments),
          });
          expect(remaining).toBeGreaterThanOrEqual(0);
          const input = {
            ...fixture,
            settlement,
            totals: {
              netAmountMinor: cents(total),
              vatAmountMinor: cents(0),
              grossAmountMinor: cents(total),
              vatBreakdown: [],
            },
            invoice: { ...fixture.invoice, documentType, currency: "EUR" },
            seller: {
              ...fixture.seller,
              country: "SK",
              iban: "SK9611000000002918599669",
            },
          };
          const qr = buildInvoicePaymentPayload(input)?.unwrap();
          if (documentType === "credit_note") {
            expect(settlement).toEqual({ status: "not_payable" });
            expect(qr).toBeUndefined();
            expect(buildInvoiceTemplateData(input).unwrap().payment).toEqual({
              status: "not_payable",
            });
            return;
          }
          if (remaining === 0) {
            expect(qr).toBeUndefined();
            expect(buildInvoiceTemplateData(input).unwrap().payment).toEqual({
              status: "settled",
              statement: "Uhrazeno",
            });
            return;
          }
          expect(settlement).toEqual({
            status: "due",
            amountMinor: cents(remaining),
          });
          const expected = buildPayBySquarePayload({
            documentType,
            iban: input.seller.iban,
            bic: input.seller.bic,
            beneficiaryName: input.seller.legalName,
            amountMinor: cents(remaining),
            currency: "EUR",
            dueDate: input.invoice.dueDate,
            variableSymbol: "0987654321",
            message: input.invoice.invoiceNumber,
          }).unwrap();
          expect(qr).toMatchObject(expected);
          const czech = buildInvoicePaymentPayload({
            ...input,
            seller: fixture.seller,
          })?.unwrap();
          expect(czech?.status === "payable" && czech.payload).toContain(
            `*AM:${(remaining / 100).toFixed(2)}*`,
          );
        };
        check();
        for (const action of actions) {
          switch (action.action) {
            case "record": {
              const amount = Math.min(remaining, action.amount);
              payments.push({ amount, voidedAt: null });
              remaining -= amount;
              break;
            }
            case "void": {
              const payment = payments.at(
                action.amount % Math.max(1, payments.length),
              );
              if (payment?.voidedAt === null) {
                remaining += payment.amount;
                payment.voidedAt = new Date("2026-10-20T00:00:00Z");
              }
              break;
            }
            default:
              action.action satisfies never;
              throw new TypeError("Unknown payment action");
          }
          check();
        }
      },
    ),
    { numRuns: 50 },
  );
});
