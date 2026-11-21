import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects currency scaling through nested money names and bigint factors", async () => {
  expect(
    await lintSingleRule(
      "no-literal-minor-unit-scale",
      "amountCents / 100;\n100 * price;\n(defaultValues?.amount ?? 0) / 100;\nMath.round(row.totalCents + fee) / 100;\nbigAmountCents / 100n;",
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("rejects scaling parsed text through bare and namespace calls", async () => {
  expect(
    await lintSingleRule(
      "no-literal-minor-unit-scale",
      "Number(input) * 100;\nNumber.parseFloat(input) * 100;\nparser.parseInt(input, 10) / 100;",
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts percentage rounding other factors and named conversions", async () => {
  expect(
    await lintSingleRule(
      "no-literal-minor-unit-scale",
      "(elapsedMinutes * percent) / 100;\nMath.round(x * 100) / 100;\n100 / amountCents;\namountCents / 1000;\ntoMinorUnits({ amount, currency });",
    ),
  ).toEqual([]);
});

test("exempts the money percentage contract owner", async () => {
  expect(
    await lintSingleRule("no-literal-minor-unit-scale", "amountCents / 100;", {
      sourcePath: "packages/money/src/index.ts",
    }),
  ).toEqual([]);
});

test("does not exempt other index modules", async () => {
  expect(
    await lintSingleRule("no-literal-minor-unit-scale", "amountCents / 100;", {
      sourcePath: "packages/other/src/index.ts",
    }),
  ).toEqual([1]);
});
