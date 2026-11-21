// Only group callbacks actually passed to an owner fold may read condition
// semantics; neither a value import alone nor a type-only import exempts a
// module. This fixture covers declaration-level type imports. Specifier-level
// type imports have the same boundary and are covered in the behavior tests.
import type { foldCondition } from "@stll/conditions";

// Reference the type-only import so it is not flagged as unused; this does
// not run the fold, which is exactly the point of this fixture.
type _FoldConditionType = typeof foldCondition;

declare const node: { combinator: "and" | "or"; negated: boolean };

// oxlint-disable-next-line no-condition-combinator-outside-conditions/no-condition-combinator-outside-conditions
const _combinator = node.combinator;

// oxlint-disable-next-line no-condition-combinator-outside-conditions/no-condition-combinator-outside-conditions
const _negated = node.negated;

export const __noConditionCombinatorOutsideConditionsTypeImportFixture = {
  _combinator,
  _negated,
};

export type { _FoldConditionType as FoldConditionType };
