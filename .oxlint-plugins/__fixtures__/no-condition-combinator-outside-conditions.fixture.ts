declare const node: { combinator: "and" | "or"; negated: boolean };

// Reading combinator or negated off a condition-tree node re-implements the
// package's own semantics: the rule must report both.

// oxlint-disable-next-line no-condition-combinator-outside-conditions/no-condition-combinator-outside-conditions
const _combinator = node.combinator;

// oxlint-disable-next-line no-condition-combinator-outside-conditions/no-condition-combinator-outside-conditions
const _negated = node.negated;

// Building a new node with these keys is an object literal, not a member
// read, and stays valid.
const _built = { combinator: "and" as const, negated: false };

// Computed access is out of scope for this syntactic rule.
const combinatorKey = "combinator" as const;
const _computed = node[combinatorKey];

export const __noConditionCombinatorOutsideConditionsFixture = {
  _combinator,
  _negated,
  _built,
  _computed,
};
