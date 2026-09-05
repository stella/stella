import { expect, test } from "bun:test";

import {
  majorUnitInput,
  submittedRateCents,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/amount-input.logic";

test("a rate typed under one currency is scaled by the one submitted", () => {
  // The reported defect: the rate input blurs under USD, the currency beside
  // it is then changed to JPY, and the entry is submitted. 100 is 100 yen.
  expect(
    submittedRateCents({
      draft: "100.00",
      currency: "JPY",
      resolvedRateCents: 10_000,
    }),
  ).toBe(100);
  expect(
    submittedRateCents({
      draft: "100.00",
      currency: "USD",
      resolvedRateCents: 0,
    }),
  ).toBe(10_000);
  expect(
    submittedRateCents({
      draft: "100",
      currency: "KWD",
      resolvedRateCents: 0,
    }),
  ).toBe(100_000);
});

test("a rate that is not overridden keeps the one rate resolution supplied", () => {
  expect(
    submittedRateCents({
      draft: null,
      currency: "JPY",
      resolvedRateCents: 4500,
    }),
  ).toBe(4500);
});

test("a draft the currency cannot express falls back rather than storing nothing", () => {
  for (const draft of ["", "abc", "99999999999999999"]) {
    expect(
      submittedRateCents({ draft, currency: "USD", resolvedRateCents: 4500 }),
    ).toBe(4500);
  }
});

test("the draft scales the decimal rather than a float parsed from it", () => {
  expect(
    submittedRateCents({
      draft: "1.005",
      currency: "USD",
      resolvedRateCents: 0,
    }),
  ).toBe(101);
});

test("the input text shows the places the currency counts", () => {
  expect(majorUnitInput(10_000, "USD")).toBe("100.00");
  expect(majorUnitInput(100, "JPY")).toBe("100");
  expect(majorUnitInput(100_000, "KWD")).toBe("100.000");
});
