// A type-only import of the fold cannot run it at runtime, so unlike a
// value import it does not exempt the module: the rule must still report a
// combinator/negated read here. This fixture covers the declaration-level
// form (`import type { foldCondition }`); the specifier-level form
// (`import { type foldConditions }`) is rejected by the same
// `importKind === "type"` check and is not repeated in a second import from
// the same module here, to avoid an unrelated import/no-duplicates finding.
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
