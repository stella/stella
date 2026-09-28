import { expect, test } from "bun:test";
import fc from "fast-check";

import { cents } from "@stll/money";
import { propertyConfig, propertySeed } from "@stll/property-testing";

import { calculateDocumentTotals } from "./invoice-document";

const lineArbitrary = fc.record({
  description: fc.string({ maxLength: 20 }),
  netAmountMinor: fc.integer({ min: 0, max: 1_000_000 }).map(cents),
  vatRateBps: fc.constantFrom(0, 500, 2100, 5000),
  vatTreatment: fc.constantFrom(
    "domestic_vat",
    "not_vat_payer",
    "reverse_charge",
    "exempt",
  ),
});

test("line sums, rate breakdowns, and credit note reversals agree", () => {
  fc.assert(
    fc.property(
      fc.array(lineArbitrary, { minLength: 1, maxLength: 20 }),
      (lines) => {
        const invoice = calculateDocumentTotals({
          documentType: "invoice",
          lines,
        });
        const credit = calculateDocumentTotals({
          documentType: "credit_note",
          lines,
        });

        for (const amount of [
          "netAmountMinor",
          "vatAmountMinor",
          "grossAmountMinor",
        ] as const) {
          expect(
            invoice.lines.reduce((sum, line) => sum + line[amount], 0),
          ).toBe(invoice.totals[amount]);
          expect(
            invoice.totals.vatBreakdown.reduce(
              (sum, rate) => sum + rate[amount],
              0,
            ),
          ).toBe(invoice.totals[amount]);
          expect(credit.totals[amount] + invoice.totals[amount]).toBe(0);
        }

        expect(credit.lines).toEqual(
          invoice.lines.map((line) => ({
            description: line.description,
            vatRateBps: line.vatRateBps,
            vatTreatment: line.vatTreatment,
            netAmountMinor: cents(-line.netAmountMinor || 0),
            vatAmountMinor: cents(-line.vatAmountMinor || 0),
            grossAmountMinor: cents(-line.grossAmountMinor || 0),
          })),
        );
        expect(credit.totals.vatBreakdown).toEqual(
          invoice.totals.vatBreakdown.map((rate) => ({
            vatRateBps: rate.vatRateBps,
            vatTreatment: rate.vatTreatment,
            netAmountMinor: cents(-rate.netAmountMinor || 0),
            vatAmountMinor: cents(-rate.vatAmountMinor || 0),
            grossAmountMinor: cents(-rate.grossAmountMinor || 0),
          })),
        );
      },
    ),
    propertyConfig({ numRuns: 300, seed: propertySeed() }),
  );
});
