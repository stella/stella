import { describe, expect, test } from "bun:test";

import {
  currencyMinorUnitDigits,
  formatMoneyCents,
  toMajorUnits,
  toMinorUnits,
} from "./format";

describe("currencyMinorUnitDigits", () => {
  test("asks the currency, not the reader", () => {
    expect(currencyMinorUnitDigits("CZK")).toBe(2);
    expect(currencyMinorUnitDigits("JPY")).toBe(0);
    expect(currencyMinorUnitDigits("KWD")).toBe(3);
  });

  test("falls back to the ISO default for a code Intl rejects", () => {
    expect(currencyMinorUnitDigits("A1C")).toBe(2);
  });
});

describe("toMinorUnits", () => {
  test("scales by the currency's own exponent", () => {
    expect(toMinorUnits({ amount: 15, currency: "USD" })).toBe(1500);
    // A zero-exponent currency counts whole units: 1500 yen is 1500.
    expect(toMinorUnits({ amount: 1500, currency: "JPY" })).toBe(1500);
    // A three-exponent currency counts thousandths.
    expect(toMinorUnits({ amount: 15, currency: "KWD" })).toBe(15_000);
  });

  test("rounds to the exact integer the currency can store", () => {
    expect(toMinorUnits({ amount: 12.345, currency: "USD" })).toBe(1235);
    expect(toMinorUnits({ amount: 1500.4, currency: "JPY" })).toBe(1500);
    expect(toMinorUnits({ amount: 12.3456, currency: "KWD" })).toBe(12_346);
  });

  test("falls back to the ISO default for a code Intl rejects", () => {
    expect(toMinorUnits({ amount: 15, currency: "A1C" })).toBe(1500);
  });

  test("refuses an amount that cannot become an exact integer", () => {
    expect(() => toMinorUnits({ amount: Number.NaN, currency: "USD" })).toThrow(
      "integer minor units",
    );
  });
});

describe("toMajorUnits", () => {
  test("is the inverse of toMinorUnits for every exponent", () => {
    expect(toMajorUnits({ amountCents: 1500, currency: "USD" })).toBe(15);
    expect(toMajorUnits({ amountCents: 1500, currency: "JPY" })).toBe(1500);
    expect(toMajorUnits({ amountCents: 15_000, currency: "KWD" })).toBe(15);
  });

  test("falls back to the ISO default for a code Intl rejects", () => {
    expect(toMajorUnits({ amountCents: 1500, currency: "A1C" })).toBe(15);
  });
});

describe("formatMoneyCents", () => {
  test("scales by the currency's own exponent", () => {
    expect(
      formatMoneyCents({ amountCents: 1500, currency: "USD", locale: "en-US" }),
    ).toBe("$15.00");
    // 1500 yen is 1500 yen: a zero-exponent currency must not be divided.
    expect(
      formatMoneyCents({ amountCents: 1500, currency: "JPY", locale: "en-US" }),
    ).toBe("¥1,500");
    expect(
      formatMoneyCents({
        amountCents: 15_000,
        currency: "KWD",
        locale: "en-US",
      }),
    ).toBe("KWD\u00A015.000");
  });

  test("pins the shown digits when the caller asks for a rounded summary", () => {
    expect(
      formatMoneyCents({
        amountCents: 123_456,
        currency: "USD",
        locale: "en-US",
        fractionDigits: 0,
      }),
    ).toBe("$1,235");
    expect(
      formatMoneyCents({
        amountCents: 123_456,
        currency: "KWD",
        locale: "en-US",
        fractionDigits: 0,
      }),
    ).toBe("KWD\u00A0123");
  });

  test("shows the amount beside a code Intl rejects instead of throwing", () => {
    expect(
      formatMoneyCents({ amountCents: 1500, currency: "A1C", locale: "en-US" }),
    ).toBe("15.00 A1C");
    expect(
      formatMoneyCents({
        amountCents: 1500,
        currency: "A1C",
        locale: "en-US",
        fractionDigits: 0,
      }),
    ).toBe("15 A1C");
  });
});
