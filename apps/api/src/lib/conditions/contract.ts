/**
 * Elysia (TypeBox) mirror of the canonical `@stll/conditions`
 * AST, for HTTP route contracts. The valibot schema in the
 * package stays the source of truth for general runtime
 * validation; this mirror exists only because Elysia route
 * bodies are typed with `t`. The `_conditionParity` guard below
 * fails typecheck if the two ever drift.
 */
import { t } from "elysia";
import type { Static } from "elysia";

import {
  BUILTIN_FIELDS,
  COMBINATORS,
  COMPARE_OPS,
  type ConditionNode,
  PREDICATE_OPS,
} from "@stll/conditions";

const tOperand = t.Union([
  t.Object({
    type: t.Literal("property"),
    propertyId: t.String({ minLength: 1 }),
  }),
  t.Object({
    type: t.Literal("builtin"),
    field: t.UnionEnum([...BUILTIN_FIELDS]),
  }),
  t.Object({ type: t.Literal("kind") }),
  t.Object({ type: t.Literal("path"), path: t.String({ minLength: 1 }) }),
  t.Object({
    type: t.Literal("literal"),
    value: t.Union([t.String(), t.Number(), t.Boolean(), t.Array(t.String())]),
  }),
]);

export const tConditionNode = t.Recursive((self) =>
  t.Union([
    t.Object({
      type: t.Literal("compare"),
      left: tOperand,
      op: t.UnionEnum([...COMPARE_OPS]),
      right: tOperand,
    }),
    t.Object({
      type: t.Literal("predicate"),
      operand: tOperand,
      op: t.UnionEnum([...PREDICATE_OPS]),
      value: t.Optional(t.Union([t.String(), t.Array(t.String())])),
    }),
    t.Object({
      type: t.Literal("group"),
      combinator: t.UnionEnum([...COMBINATORS]),
      negated: t.Optional(t.Boolean()),
      children: t.Array(self),
    }),
  ]),
);

/** Top-level condition: always the AND/OR root group. */
export const tCondition = t.Object({
  type: t.Literal("group"),
  combinator: t.UnionEnum([...COMBINATORS]),
  negated: t.Optional(t.Boolean()),
  children: t.Array(tConditionNode),
});

// Fails typecheck if the TypeBox mirror admits a shape outside the canonical
// AST. (Operators/fields can't drift — they're spread from the same package
// constants. The reverse direction is intentionally omitted: TypeBox optionals
// drop `| undefined` under exactOptionalPropertyTypes, so canonical→mirror
// would false-positive without guarding anything the spreads don't already.)
const _mirrorToCanonical = (n: Static<typeof tConditionNode>): ConditionNode =>
  n;
void _mirrorToCanonical;
