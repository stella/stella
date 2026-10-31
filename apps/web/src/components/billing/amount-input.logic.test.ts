import { expect, test } from "bun:test";

import { localeInputText } from "@stll/money";

import {
  majorUnitInput,
  normalizeMajorUnitInput,
  submittedRateCents,
} from "@/components/billing/amount-input.logic";

/** Text as a person typed it into the rate input. */
const typed = (value: string) => localeInputText({ value, tagName: "INPUT" });

test("localized decimal normalization preserves every digit and is canonical", () => {
  const decimal = "90071992547409.915";
  expect(normalizeMajorUnitInput({ input: decimal, locale: "en" })).toBe(
    decimal,
  );
  expect(
    normalizeMajorUnitInput({ input: "90071992547409,915", locale: "cs" }),
  ).toBe(decimal);
  expect(
    normalizeMajorUnitInput({
      input: "٩٠٠٧١٩٩٢٥٤٧٤٠٩٫٩١٥",
      locale: "ar-u-nu-arab",
    }),
  ).toBe(decimal);
});

test("a rate typed under one currency is scaled by the one submitted", () => {
  // The reported defect: the rate input blurs under USD, the currency beside
  // it is then changed to JPY, and the entry is submitted. 100 is 100 yen.
  expect(
    submittedRateCents({
      draft: typed("100"),
      currency: "JPY",
      locale: "en-US",
      resolvedRateCents: 10_000,
    }),
  ).toBe(100);
  expect(
    submittedRateCents({
      draft: typed("100.00"),
      currency: "USD",
      locale: "en-US",
      resolvedRateCents: 0,
    }),
  ).toBe(10_000);
  expect(
    submittedRateCents({
      draft: typed("100"),
      currency: "KWD",
      locale: "en-US",
      resolvedRateCents: 0,
    }),
  ).toBe(100_000);
});

test("a rate that is not overridden keeps the one rate resolution supplied", () => {
  expect(
    submittedRateCents({
      draft: null,
      currency: "JPY",
      locale: "en-US",
      resolvedRateCents: 4500,
    }),
  ).toBe(4500);
});

test("a draft the currency cannot express falls back rather than storing nothing", () => {
  for (const draft of ["", "abc", "99999999999999999"].map(localeInputText)) {
    expect(
      submittedRateCents({
        draft,
        currency: "USD",
        locale: "en-US",
        resolvedRateCents: 4500,
      }),
    ).toBe(4500);
  }
});

test("the draft scales the decimal rather than a float parsed from it", () => {
  expect(
    submittedRateCents({
      draft: typed("1.005"),
      currency: "KWD",
      locale: "en-US",
      resolvedRateCents: 0,
    }),
  ).toBe(1005);
});

test("a Slovak rate accepts its decimal mark and rejects an ambiguous dot", () => {
  expect(
    submittedRateCents({
      draft: typed("1234,56"),
      currency: "EUR",
      locale: "sk-SK",
      resolvedRateCents: 0,
    }),
  ).toBe(123_456);
  expect(
    submittedRateCents({
      draft: typed("1.234"),
      currency: "EUR",
      locale: "sk-SK",
      resolvedRateCents: 777,
    }),
  ).toBe(777);
});

test("the input text shows the places the currency counts", () => {
  expect(majorUnitInput(10_000, "USD", "en")).toBe(typed("100.00"));
  expect(majorUnitInput(100, "JPY", "en")).toBe(typed("100"));
  expect(majorUnitInput(100_000, "KWD", "en")).toBe(typed("100.000"));
});

test("the input text is written in the locale it is read back in", () => {
  // Three minor-unit places after a dot read as grouping in sk, so text
  // formatted for another locale would come back ambiguous.
  for (const locale of ["sk", "cs", "de", "en", "en-IN"]) {
    for (const [amountCents, currency] of [
      [150_500, "KWD"],
      [15_050, "EUR"],
      [150, "JPY"],
    ] as const) {
      expect(
        submittedRateCents({
          draft: majorUnitInput(amountCents, currency, locale),
          currency,
          resolvedRateCents: 0,
          locale,
        }),
      ).toBe(amountCents);
    }
  }
});
