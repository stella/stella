import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  calculateDocumentTotals,
  type InvoiceDocumentType,
  type InvoiceLineInput,
  type VatTreatment,
} from "@stll/invoicing";
import { applyMarkupCents, cents, timeEntryAmount } from "@stll/money";
import { assertProperty } from "@stll/property-testing";

const VAT_TREATMENTS: readonly VatTreatment[] = [
  "domestic_vat",
  "not_vat_payer",
  "outside_scope",
  "reverse_charge",
  "exempt",
];

const lineArb: fc.Arbitrary<InvoiceLineInput> = fc.record({
  description: fc.constant("Legal services"),
  netAmountMinor: fc.integer({ min: 0, max: 1_000_000 }).map((n) => cents(n)),
  vatTreatment: fc.constantFrom(...VAT_TREATMENTS),
  vatRateBps: fc.constantFrom(0, 500, 1000, 1900, 2000, 2100, 2300),
});

describe("money and invoice line calculation properties", () => {
  test("applyMarkupCents with 0 percent is identity and positive markup is non-decreasing", () => {
    assertProperty(
      "applyMarkupCents with 0 percent is identity and positive markup is non-decreasing",
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 500 }),
        (baseMinor, markupPercent) => {
          const base = cents(baseMinor);
          expect(
            applyMarkupCents({ amountCents: base, markupPercent: 0 }),
          ).toBe(base);
          const markedUp = applyMarkupCents({
            amountCents: base,
            markupPercent,
          });
          expect(markedUp).toBeGreaterThanOrEqual(base);
        },
      ),
    );
  });

  test("timeEntryAmount is 0 when noCharge, duration, or rate is 0 and monotonic in duration", () => {
    assertProperty(
      "timeEntryAmount is 0 when noCharge, duration, or rate is 0 and monotonic in duration",
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 600 }),
        (billedMinutes, hourlyRate, extraMinutes) => {
          expect(
            timeEntryAmount({
              billedMinutes,
              rateAtEntry: cents(hourlyRate),
              noCharge: true,
            }),
          ).toBe(cents(0));
          expect(
            timeEntryAmount({
              billedMinutes: 0,
              rateAtEntry: cents(hourlyRate),
              noCharge: false,
            }),
          ).toBe(cents(0));
          expect(
            timeEntryAmount({
              billedMinutes,
              rateAtEntry: cents(0),
              noCharge: false,
            }),
          ).toBe(cents(0));
          const before = timeEntryAmount({
            billedMinutes,
            rateAtEntry: cents(hourlyRate),
            noCharge: false,
          });
          const after = timeEntryAmount({
            billedMinutes: billedMinutes + extraMinutes,
            rateAtEntry: cents(hourlyRate),
            noCharge: false,
          });
          expect(after).toBeGreaterThanOrEqual(before);
        },
      ),
    );
  });

  test("calculateDocumentTotals satisfies gross = net + vat and breakdown conservation", () => {
    assertProperty(
      "calculateDocumentTotals satisfies gross = net + vat and breakdown conservation",
      fc.property(
        fc.array(lineArb, { minLength: 0, maxLength: 15 }),
        fc.constantFrom<InvoiceDocumentType>(
          "invoice",
          "advance",
          "credit_note",
        ),
        (lines, documentType) => {
          const result = calculateDocumentTotals({ documentType, lines });
          expect(result.isOk()).toBe(true);
          if (result.isErr()) {
            return;
          }
          const { totals } = result.value;
          const sign = documentType === "credit_note" ? -1 : 1;
          let expectedNet = 0;
          for (const line of lines) {
            expectedNet += line.netAmountMinor * sign;
          }
          expect(totals.netAmountMinor).toBe(cents(expectedNet || 0));
          expect(totals.grossAmountMinor).toBe(
            cents(totals.netAmountMinor + totals.vatAmountMinor),
          );
          let breakdownNet = 0;
          let breakdownVat = 0;
          let breakdownGross = 0;
          for (const bucket of totals.vatBreakdown) {
            breakdownNet += bucket.netAmountMinor;
            breakdownVat += bucket.vatAmountMinor;
            breakdownGross += bucket.grossAmountMinor;
          }
          expect(breakdownNet).toBe(totals.netAmountMinor);
          expect(breakdownVat).toBe(totals.vatAmountMinor);
          expect(breakdownGross).toBe(totals.grossAmountMinor);
          if (documentType === "credit_note") {
            expect(totals.netAmountMinor).toBeLessThanOrEqual(0);
            expect(totals.vatAmountMinor).toBeLessThanOrEqual(0);
            expect(totals.grossAmountMinor).toBeLessThanOrEqual(
              totals.netAmountMinor,
            );
          } else {
            expect(totals.netAmountMinor).toBeGreaterThanOrEqual(0);
            expect(totals.vatAmountMinor).toBeGreaterThanOrEqual(0);
            expect(totals.grossAmountMinor).toBeGreaterThanOrEqual(
              totals.netAmountMinor,
            );
          }
        },
      ),
    );
  });
});
