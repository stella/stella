import { describe, expect, test } from "bun:test";

import {
  currencyMinorUnitDigits,
  formatHundredths,
  formatMoneyCents,
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

describe("formatMoneyCents", () => {
  test("scales by the currency's own exponent", () => {
    expect(
      formatMoneyCents({ amountCents: 1500, currency: "USD", locale: "en-US" }),
    ).toBe("$15.00");
    // 1500 yen is 1500 yen: a zero-exponent currency must not be divided.
    expect(
      formatMoneyCents({ amountCents: 1500, currency: "JPY", locale: "en-US" }),
    ).toBe("¥1,500");
  });

  test("shows the amount beside a code Intl rejects instead of throwing", () => {
    expect(
      formatMoneyCents({ amountCents: 1500, currency: "A1C", locale: "en-US" }),
    ).toBe("15 A1C");
  });
});

describe("formatHundredths", () => {
  test("renders the two-digit billing preset", () => {
    expect(
      formatHundredths({
        amountCents: 123_456,
        currency: "USD",
        locale: "en-US",
        fractionDigits: 2,
      }),
    ).toBe("$1,234.56");
  });

  test("renders the rounded summary preset", () => {
    expect(
      formatHundredths({
        amountCents: 123_456,
        currency: "USD",
        locale: "en-US",
        fractionDigits: 0,
      }),
    ).toBe("$1,235");
  });

  test("keeps the hundredth assumption a zero-exponent currency does not share", () => {
    // Documented wrongness: billing stores every currency in hundredths, so
    // 1500 minor units renders as 15 yen rather than 1500. The money model
    // change that fixes it is tracked separately.
    expect(
      formatHundredths({
        amountCents: 1500,
        currency: "JPY",
        locale: "en-US",
        fractionDigits: 0,
      }),
    ).toBe("¥15");
  });

  test("falls back to the digits it was asked for", () => {
    expect(
      formatHundredths({
        amountCents: 1500,
        currency: "A1C",
        locale: "en-US",
        fractionDigits: 2,
      }),
    ).toBe("15.00 A1C");
  });
});
