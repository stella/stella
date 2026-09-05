import { describe, expect, test } from "bun:test";

import { cents } from "./cents";
import {
  currencyMinorUnitDigits,
  formatMoneyCents,
  toMajorUnits,
  toMinorUnits,
  tryToMinorUnits,
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
    expect(toMinorUnits({ amount: 15, currency: "USD" })).toBe(cents(1500));
    // A zero-exponent currency counts whole units: 1500 yen is 1500.
    expect(toMinorUnits({ amount: 1500, currency: "JPY" })).toBe(cents(1500));
    // A three-exponent currency counts thousandths.
    expect(toMinorUnits({ amount: 15, currency: "KWD" })).toBe(cents(15_000));
  });

  test("rounds to the exact integer the currency can store", () => {
    expect(toMinorUnits({ amount: 12.345, currency: "USD" })).toBe(cents(1235));
    expect(toMinorUnits({ amount: 1500.4, currency: "JPY" })).toBe(cents(1500));
    expect(toMinorUnits({ amount: 12.3456, currency: "KWD" })).toBe(
      cents(12_346),
    );
  });

  test("scales the decimal, not the float: 1.005 USD is 101", () => {
    // `1.005 * 100` is 100.49999999999999, so a float multiply rounds it down
    // and the line item loses a cent. The digits say 101 either way.
    expect(1.005 * 100).toBeLessThan(100.5);
    expect(toMinorUnits({ amount: 1.005, currency: "USD" })).toBe(cents(101));
    expect(toMinorUnits({ amount: "1.005", currency: "USD" })).toBe(cents(101));
    // The same shortfall at the currency's own boundary, three decimals in.
    expect(toMinorUnits({ amount: 1.0005, currency: "KWD" })).toBe(cents(1001));
    expect(toMinorUnits({ amount: "8.1235", currency: "KWD" })).toBe(
      cents(8124),
    );
    // A zero-digit currency rounds on the first decimal and nothing else.
    expect(toMinorUnits({ amount: "1500.5", currency: "JPY" })).toBe(
      cents(1501),
    );
    expect(toMinorUnits({ amount: "1500.49", currency: "JPY" })).toBe(
      cents(1500),
    );
  });

  test("carries a rounded fraction into the whole part", () => {
    expect(toMinorUnits({ amount: "0.999", currency: "USD" })).toBe(cents(100));
    expect(toMinorUnits({ amount: "9.9999", currency: "KWD" })).toBe(
      cents(10_000),
    );
  });

  test("reads text the way it was typed, including the odd shapes", () => {
    expect(toMinorUnits({ amount: " 12.5 ", currency: "USD" })).toBe(
      cents(1250),
    );
    expect(toMinorUnits({ amount: ".5", currency: "USD" })).toBe(cents(50));
    expect(toMinorUnits({ amount: "12.", currency: "USD" })).toBe(cents(1200));
    expect(toMinorUnits({ amount: "-1.005", currency: "USD" })).toBe(
      cents(-101),
    );
    // Scientific notation is what `String` gives a very small or large number.
    expect(toMinorUnits({ amount: 1e-7, currency: "USD" })).toBe(cents(0));
    expect(toMinorUnits({ amount: 1.5e3, currency: "JPY" })).toBe(cents(1500));
  });

  test("refuses text it cannot scale", () => {
    for (const bad of ["", "abc", "12abc", "1,005", "0x10", "."]) {
      expect(tryToMinorUnits({ amount: bad, currency: "USD" })).toBeNull();
      expect(() => toMinorUnits({ amount: bad, currency: "USD" })).toThrow(
        "not an amount USD can store",
      );
    }
  });

  test("tryToMinorUnits declines what toMinorUnits would panic on", () => {
    // The gate a form needs: unparseable text, and text whose scaled value
    // would leave the range where +1 still moves.
    expect(
      tryToMinorUnits({ amount: "99999999999999999", currency: "USD" }),
    ).toBeNull();
    for (const good of ["0", "12", "12.5", ".5", "12.", " 1.005 ", "-3.20"]) {
      expect(tryToMinorUnits({ amount: good, currency: "USD" })).toBe(
        toMinorUnits({ amount: good, currency: "USD" }),
      );
    }
  });

  test("falls back to the ISO default for a code Intl rejects", () => {
    expect(toMinorUnits({ amount: 15, currency: "A1C" })).toBe(cents(1500));
  });

  test("refuses an amount that cannot become an exact integer", () => {
    expect(() => toMinorUnits({ amount: Number.NaN, currency: "USD" })).toThrow(
      "not an amount USD can store",
    );
    expect(() => toMinorUnits({ amount: Infinity, currency: "USD" })).toThrow(
      "not an amount USD can store",
    );
    // Past the safe range the scaled value stops being the amount it names.
    expect(() =>
      toMinorUnits({ amount: "99999999999999999", currency: "USD" }),
    ).toThrow("not an amount USD can store");
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
