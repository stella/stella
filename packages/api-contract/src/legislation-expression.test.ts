import { describe, expect, test } from "bun:test";

import {
  isEligibleLegislationExpression,
  LEGISLATION_APPLICABLE_EXPRESSION_KINDS,
  LEGISLATION_EXPRESSION_KIND_APPLIES,
  LEGISLATION_EXPRESSION_KINDS,
} from "./legislation-expression";

describe("which expression kinds can apply", () => {
  test("every declared kind carries a decision, and nothing else does", () => {
    expect(Object.keys(LEGISLATION_EXPRESSION_KIND_APPLIES).toSorted()).toEqual(
      [...LEGISLATION_EXPRESSION_KINDS].toSorted(),
    );
  });

  test("the applicable list is exactly the kinds decided applicable", () => {
    expect(LEGISLATION_APPLICABLE_EXPRESSION_KINDS).toEqual(
      LEGISLATION_EXPRESSION_KINDS.filter(
        (kind) => LEGISLATION_EXPRESSION_KIND_APPLIES[kind],
      ),
    );
    // Both sides of the decision are reached.
    expect(LEGISLATION_APPLICABLE_EXPRESSION_KINDS).toContain("consolidation");
    expect(LEGISLATION_APPLICABLE_EXPRESSION_KINDS).not.toContain(
      "promulgated",
    );
  });

  test.each(LEGISLATION_EXPRESSION_KINDS)(
    "an effective %s applies only when its kind is decided applicable",
    (kind) => {
      expect(
        isEligibleLegislationExpression({
          expressionKind: kind,
          windowDisposition: "effective",
        }),
      ).toBe(LEGISLATION_EXPRESSION_KIND_APPLIES[kind]);
    },
  );
});
