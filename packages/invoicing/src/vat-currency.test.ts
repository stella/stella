import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { cents } from "@stll/money";
import { assertProperty } from "@stll/property-testing";

import {
  homeCurrencyVat,
  normalizeVatExchangeRate,
  vatRateReferenceDate,
  vatTaxPointDate,
} from "./vat-currency";

describe("VAT currency", () => {
  test("selects each country's statutory tax point", () => {
    expect(
      vatTaxPointDate({
        country: "CZ",
        invoiceDate: "2026-10-20",
        taxableSupplyDate: "2026-10-22",
      }),
    ).toBe("2026-10-20");
    expect(
      vatTaxPointDate({
        country: "CZ",
        invoiceDate: "2026-10-20",
        taxableSupplyDate: "2026-10-18",
      }),
    ).toBe("2026-10-18");
    expect(
      vatTaxPointDate({
        country: "SK",
        invoiceDate: "2026-10-20",
        taxableSupplyDate: "2026-10-18",
      }),
    ).toBe("2026-10-18");
    expect(
      vatTaxPointDate({
        country: "PL",
        invoiceDate: "2026-10-20",
        taxableSupplyDate: null,
      }),
    ).toBe("2026-10-20");
  });

  test("a Polish invoice issued before the supply keys the rate to its issue date", () => {
    // Art. 31a ust. 2: the rate preceding the issue date, not the tax point.
    expect(
      vatRateReferenceDate({
        country: "PL",
        invoiceDate: "2026-10-20",
        taxableSupplyDate: "2026-10-31",
      }),
    ).toBe("2026-10-20");
    expect(
      vatRateReferenceDate({
        country: "PL",
        invoiceDate: "2026-11-03",
        taxableSupplyDate: "2026-10-31",
      }),
    ).toBe("2026-10-31");
    // Slovakia keys the rate to the tax point even for an early invoice.
    expect(
      vatRateReferenceDate({
        country: "SK",
        invoiceDate: "2026-10-20",
        taxableSupplyDate: "2026-10-31",
      }),
    ).toBe("2026-10-31");
  });

  test("normalizes a quote to one unit without floating point", () => {
    expect(normalizeVatExchangeRate({ quote: "15.25", units: 100n })).toBe(
      "0.1525",
    );
    expect(normalizeVatExchangeRate({ quote: "1.25", units: 1n })).toBe("1.25");
  });

  test("an ECB quote converts by one exact division, so a half cent still rounds up", () => {
    // 3 US cents at 1.2 USD/EUR is exactly 2.5 euro cents; a pre-rounded
    // inverse (0.833333333333) would give 2.
    const result = homeCurrencyVat({
      country: "SK",
      rate: "1.2",
      source: "ECB",
      vatBreakdown: [
        {
          vatRateBps: 2300,
          vatTreatment: "domestic_vat",
          netAmountMinor: cents(13),
          vatAmountMinor: cents(3),
          grossAmountMinor: cents(16),
        },
      ],
    });
    expect(Number(result.totalVatAmountMinor)).toBe(3);
  });

  test("rounds every VAT bucket half-up to the minor unit", () => {
    const result = homeCurrencyVat({
      country: "PL",
      rate: "4.005",
      source: "NBP",
      vatBreakdown: [
        {
          vatRateBps: 2300,
          vatTreatment: "domestic_vat",
          netAmountMinor: cents(100),
          vatAmountMinor: cents(100),
          grossAmountMinor: cents(200),
        },
      ],
    });
    expect(Number(result.totalVatAmountMinor)).toBe(401);
  });

  test("rounds negative VAT half away from zero, like positive VAT", () => {
    const convert = (amount: number, rate: string) =>
      Number(
        homeCurrencyVat({
          country: "PL",
          rate,
          source: "NBP",
          vatBreakdown: [
            {
              vatRateBps: 2300,
              vatTreatment: "domestic_vat",
              netAmountMinor: cents(amount),
              vatAmountMinor: cents(amount),
              grossAmountMinor: cents(amount * 2),
            },
          ],
        }).totalVatAmountMinor,
      );
    expect(convert(-100, "4.005")).toBe(-401);
    expect(convert(-100, "1")).toBe(-100);
  });

  test("each home VAT bucket is the exact conversion rounded half away from zero", () => {
    assertProperty(
      "each home VAT bucket is the exact conversion rounded half away from zero",
      fc.property(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.constantFrom("CNB", "ECB"),
        (amounts, rateThousandths, source) => {
          const result = homeCurrencyVat({
            country: source === "ECB" ? "SK" : "CZ",
            rate: `${Math.floor(rateThousandths / 1000)}.${String(rateThousandths % 1000).padStart(3, "0")}`,
            source,
            vatBreakdown: amounts.map((amount) => ({
              vatRateBps: 2100,
              vatTreatment: "domestic_vat",
              netAmountMinor: cents(0),
              vatAmountMinor: cents(amount),
              grossAmountMinor: cents(amount),
            })),
          });
          for (const [index, bucket] of result.byRate.entries()) {
            const amount = BigInt(amounts[index] ?? 0);
            const rate = BigInt(rateThousandths);
            // The exact conversion is numerator / denominator.
            const [numerator, denominator] =
              source === "ECB"
                ? [amount * 1000n, rate]
                : [amount * rate, 1000n];
            const error =
              BigInt(bucket.vatAmountMinor) * denominator - numerator;
            // Within half a minor unit, and a tie rounds away from zero.
            expect(
              error * 2n <= denominator && error * 2n >= -denominator,
            ).toBe(true);
            if (error * 2n === denominator || error * 2n === -denominator) {
              expect(error > 0n === numerator > 0n).toBe(true);
            }
          }
          expect(Number(result.totalVatAmountMinor)).toBe(
            result.byRate.reduce(
              (sum, bucket) => sum + bucket.vatAmountMinor,
              0,
            ),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
