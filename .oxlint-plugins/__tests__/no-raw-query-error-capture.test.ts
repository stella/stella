import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports direct analytics capture inside query functions", async () => {
  expect(
    await lintSingleRule(
      "no-raw-query-error-capture",
      `const first = { queryFn: async () => {
  getAnalytics().captureError(error);
} };
const second = { queryFn: function () {
  analytics.captureError(error);
} };`,
    ),
  ).toEqual([2, 5]);
});

test("accepts captures owned by the query error boundary", async () => {
  expect(
    await lintSingleRule(
      "no-raw-query-error-capture",
      `const options = { queryFn: async () => {
  captureQueryError(error, owner);
} };`,
    ),
  ).toEqual([]);
});

test("allows direct analytics capture outside query functions", async () => {
  expect(
    await lintSingleRule(
      "no-raw-query-error-capture",
      `const onError = () => getAnalytics().captureError(error);
const options = { mutationFn: async () => analytics.captureError(error) };`,
    ),
  ).toEqual([]);
});
