import { describe, expect, test } from "bun:test";

import type { LegislationWindowDispositionBasis } from "./legislation-expression";
import {
  isEligibleLegislationExpression,
  LEGISLATION_APPLICABLE_EXPRESSION_KINDS,
  LEGISLATION_EXPRESSION_KIND_APPLIES,
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITION_BASES,
  LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES,
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

test("the basis tuple lists every basis of every disposition exactly once", () => {
  // Compile-time: a basis missing from the tuple makes this type `false`.
  const total: [LegislationWindowDispositionBasis] extends [
    (typeof LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES)[number],
  ]
    ? true
    : false = true;
  expect(total).toBe(true);
  expect(LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES.toSorted()).toEqual(
    Object.values(LEGISLATION_WINDOW_DISPOSITION_BASES).flat().toSorted(),
  );
});
