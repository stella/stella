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

// Destructuring reads the same fields through an ObjectPattern instead of a
// MemberExpression, and is banned the same way.
// oxlint-disable-next-line no-condition-combinator-outside-conditions/no-condition-combinator-outside-conditions
const { combinator: _destructuredCombinator, negated: _destructuredNegated } =
  node;

// A destructured function parameter reads the fields the same way.
type ConditionNodeShape = { combinator: "and" | "or"; negated: boolean };
const readFromParam = ({
  // oxlint-disable-next-line no-condition-combinator-outside-conditions/no-condition-combinator-outside-conditions
  combinator,
}: ConditionNodeShape) => combinator;

// A type-only import of the fold cannot run it, so it does not exempt the
// module: see no-condition-combinator-outside-conditions.fixture.type-import.ts
// for the reported read that a type-only import leaves in place.

export const __noConditionCombinatorOutsideConditionsFixture = {
  _combinator,
  _negated,
  _built,
  _computed,
  _destructuredCombinator,
  _destructuredNegated,
  readFromParam,
};
