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

  test("normalizes units and inverts ECB quotes without floating point", () => {
    expect(
      normalizeVatExchangeRate({
        quote: "15.25",
        foreignUnits: 100,
        direction: "home_per_foreign",
      }),
    ).toBe("0.1525");
    expect(
      normalizeVatExchangeRate({
        quote: "1.25",
        foreignUnits: 1,
        direction: "foreign_per_home",
      }),
    ).toBe("0.8");
  });

  test("rounds every VAT bucket half-up to the minor unit", () => {
    const result = homeCurrencyVat({
      country: "PL",
      rate: "4.005",
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
        (amounts, rateThousandths) => {
          const result = homeCurrencyVat({
            country: "CZ",
            rate: `${Math.floor(rateThousandths / 1000)}.${String(rateThousandths % 1000).padStart(3, "0")}`,
            vatBreakdown: amounts.map((amount) => ({
              vatRateBps: 2100,
              vatTreatment: "domestic_vat",
              netAmountMinor: cents(0),
              vatAmountMinor: cents(amount),
              grossAmountMinor: cents(amount),
            })),
          });
          for (const [index, bucket] of result.byRate.entries()) {
            const exactThousandths =
              BigInt(amounts[index] ?? 0) * BigInt(rateThousandths);
            const roundedThousandths = BigInt(bucket.vatAmountMinor) * 1000n;
            const error = roundedThousandths - exactThousandths;
            // Within half a minor unit, and a tie rounds away from zero.
            expect(error * 2n <= 1000n && error * 2n >= -1000n).toBe(true);
            if (error * 2n === 1000n || error * 2n === -1000n) {
              expect(error > 0n === exactThousandths > 0n).toBe(true);
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
