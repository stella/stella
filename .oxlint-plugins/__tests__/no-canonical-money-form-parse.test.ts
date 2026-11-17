import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-canonical-money-form-parse";
const IMPORT = 'import { toMinorUnits, tryToMinorUnits } from "@stll/money";\n';

test("rejects canonical parsing of form field values", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `${IMPORT}tryToMinorUnits({ amount: event.currentTarget.value, currency });
tryToMinorUnits({ amount: event.target.value.trim(), currency });
toMinorUnits({ amount: field.state.value, currency });
tryToMinorUnits({ amount: dataset.value, currency });`,
    ),
  ).toEqual([2, 3, 4, 5]);
});

test("rejects canonical parsing of names that hold form text", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `${IMPORT}toMinorUnits({ amount: draft, currency });
tryToMinorUnits({ amount: input ?? "", currency });
tryToMinorUnits({ amount: values.amountInputValue, currency });
tryToMinorUnits(input);`,
    ),
  ).toEqual([2, 3, 4, 5]);
});

test("accepts stored amounts whatever surrounds the amount expression", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `${IMPORT}tryToMinorUnits({ amount: "1234.56", currency });
tryToMinorUnits({ amount: /* the draft total */ "1.00", currency });
tryToMinorUnits({ amount: "draft".length, currency });
tryToMinorUnits({ amount: invoice.total, currency: state.value });
tryToMinorUnits({ currency: input, amount: 12 });`,
    ),
  ).toEqual([]);
});

test("accepts a local function that shadows the import", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `${IMPORT}const read = (tryToMinorUnits) =>
  tryToMinorUnits({ amount: field.state.value });
read(String);`,
    ),
  ).toEqual([]);
});

test("accepts the same name from another module", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `import { tryToMinorUnits } from "./local";
tryToMinorUnits({ amount: field.state.value });`,
    ),
  ).toEqual([]);
});
