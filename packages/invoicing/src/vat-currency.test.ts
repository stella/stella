import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { cents } from "@stll/money";

import {
  homeCurrencyVat,
  normalizeVatExchangeRate,
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

  test("home VAT equals the sum of independently rounded buckets", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.integer({ min: 1, max: 100_000 }),
        (amounts, rateBasis) => {
          const result = homeCurrencyVat({
            country: "CZ",
            rate: `${Math.floor(rateBasis / 1000)}.${String(rateBasis % 1000).padStart(3, "0")}`,
            vatBreakdown: amounts.map((amount) => ({
              vatRateBps: 2100,
              vatTreatment: "domestic_vat",
              netAmountMinor: cents(0),
              vatAmountMinor: cents(amount),
              grossAmountMinor: cents(amount),
            })),
          });
          expect(Number(result.totalVatAmountMinor)).toBe(
            result.byRate.reduce(
              (sum, bucket) => sum + bucket.vatAmountMinor,
              0,
            ),
          );
        },
      ),
    );
  });
});
