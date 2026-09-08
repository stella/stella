import { describe, expect, test } from "bun:test";

import { referencedConditionPaths } from "./referenced-paths.js";

describe("referencedConditionPaths", () => {
  test("names the path a truthiness test reads", () => {
    expect(referencedConditionPaths("expenses_reimbursed")).toEqual([
      "expenses_reimbursed",
    ]);
  });

  test("names both sides of a comparison, in source order", () => {
    expect(referencedConditionPaths("term.years > minimum")).toEqual([
      "term.years",
      "minimum",
    ]);
  });

  test("a literal is not a reference", () => {
    expect(referencedConditionPaths("company_type == 'llc'")).toEqual([
      "company_type",
    ]);
  });

  test("collects across and/or groups and negation", () => {
    expect(
      referencedConditionPaths("penalty and not (amount > 0 or waived)"),
    ).toEqual(["penalty", "amount", "waived"]);
  });

  test("an expression that does not parse names nothing readable", () => {
    expect(referencedConditionPaths("")).toBeNull();
  });
});
