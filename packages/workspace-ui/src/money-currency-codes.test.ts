/**
 * The consumer-side contract this kit depends on: a money column renders
 * whatever currency code a row carries. The rendering lives in `@stll/money`;
 * the column that must not go down lives here, so the property does too.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { currencyMinorUnitDigits, formatMoneyCents } from "@stll/money";
import { propertyConfig } from "@stll/property-testing";

describe("currencyMinorUnitDigits", () => {
  test("reads the exponent from the currency", () => {
    expect(currencyMinorUnitDigits("CZK")).toBe(2);
    expect(currencyMinorUnitDigits("JPY")).toBe(0);
    expect(currencyMinorUnitDigits("KWD")).toBe(3);
  });

  test("a well-formed but unknown code is not rejected", () => {
    expect(currencyMinorUnitDigits("ZZZ")).toBe(2);
  });

  test("a code Intl will not accept falls back rather than throwing", () => {
    expect(currencyMinorUnitDigits("A1C")).toBe(2);
    expect(currencyMinorUnitDigits("")).toBe(2);
  });
});

describe("formatMoneyCents", () => {
  test("a malformed code shows the amount beside the raw code", () => {
    expect(
      formatMoneyCents({ amountCents: 1500, currency: "A1C", locale: "en" }),
    ).toBe("15.00 A1C");
  });

  test("a currency with no minor unit is not divided", () => {
    expect(
      formatMoneyCents({ amountCents: 1500, currency: "JPY", locale: "en" }),
    ).toContain("1,500");
  });
});

// Every three-character string the field schema used to admit before the
// letters-only constraint: none of them may take a column down.
const threeCharArb = fc
  .array(fc.constantFrom(..."ABCabc019 -$".split("")), {
    minLength: 3,
    maxLength: 3,
  })
  .map((chars) => chars.join(""));

describe("no stored code can throw", () => {
  test("the exponent lookup always answers", () => {
    fc.assert(
      fc.property(threeCharArb, (currency) => {
        const digits = currencyMinorUnitDigits(currency);

        expect(Number.isInteger(digits)).toBe(true);
        expect(digits).toBeGreaterThanOrEqual(0);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("formatting always answers with a non-empty string", () => {
    fc.assert(
      fc.property(
        threeCharArb,
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (currency, amountCents) => {
          const formatted = formatMoneyCents({
            amountCents,
            currency,
            locale: "en",
          });

          expect(typeof formatted).toBe("string");
          expect(formatted.length).toBeGreaterThan(0);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
