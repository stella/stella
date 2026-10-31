import { expect, test } from "bun:test";

import { localeInputText } from "@stll/money";

import {
  majorUnitInput,
  normalizeMajorUnitInput,
  submittedRateCents,
} from "@/components/billing/amount-input.logic";

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
      draft: localeInputText("100"),
      currency: "JPY",
      locale: "en-US",
      resolvedRateCents: 10_000,
    }),
  ).toBe(100);
  expect(
    submittedRateCents({
      draft: localeInputText("100.00"),
      currency: "USD",
      locale: "en-US",
      resolvedRateCents: 0,
    }),
  ).toBe(10_000);
  expect(
    submittedRateCents({
      draft: localeInputText("100"),
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
      draft: localeInputText("1.005"),
      currency: "KWD",
      locale: "en-US",
      resolvedRateCents: 0,
    }),
  ).toBe(1005);
});

test("a Slovak rate accepts its decimal mark and rejects an ambiguous dot", () => {
  expect(
    submittedRateCents({
      draft: localeInputText("1234,56"),
      currency: "EUR",
      locale: "sk-SK",
      resolvedRateCents: 0,
    }),
  ).toBe(123_456);
  expect(
    submittedRateCents({
      draft: localeInputText("1.234"),
      currency: "EUR",
      locale: "sk-SK",
      resolvedRateCents: 777,
    }),
  ).toBe(777);
});

test("the input text shows the places the currency counts", () => {
  expect(majorUnitInput(10_000, "USD")).toBe(localeInputText("100.00"));
  expect(majorUnitInput(100, "JPY")).toBe(localeInputText("100"));
  expect(majorUnitInput(100_000, "KWD")).toBe(localeInputText("100.000"));
});
