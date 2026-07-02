/**
 * Elysia (TypeBox) mirror of the canonical `@stll/conditions`
 * AST, for HTTP route contracts. The valibot schema in the
 * package stays the source of truth for general runtime
 * validation; this mirror exists only because Elysia route
 * bodies are typed with `t`. The `_conditionParity` guard below
 * fails typecheck if the two ever drift.
 */
import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
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

const tCompare = t.Object({
  type: t.Literal("compare"),
  left: tOperand,
  op: t.UnionEnum([...COMPARE_OPS]),
  right: tOperand,
});

const tPredicate = t.Object({
  type: t.Literal("predicate"),
  operand: tOperand,
  op: t.UnionEnum([...PREDICATE_OPS]),
  value: t.Optional(t.Union([t.String(), t.Array(t.String()), t.Undefined()])),
});

const tLeaf = t.Union([tCompare, tPredicate]);

const tGroupWith = <C extends TSchema>(children: C) =>
  t.Object({
    type: t.Literal("group"),
    combinator: t.UnionEnum([...COMBINATORS]),
    negated: t.Optional(t.Union([t.Boolean(), t.Undefined()])),
    children: t.Array(children),
  });

/**
 * One non-recursive level: the leaf arms plus a group whose children are
 * leaves. Reused as both the innermost level of the bounded schema and the
 * static-type reference for the canonical-parity guard below.
 */
const tNodeShape = t.Union([tCompare, tPredicate, tGroupWith(tLeaf)]);

/**
 * Maximum group-nesting depth the route contract validates. The canonical
 * `@stll/conditions` AST is unbounded, but Elysia's exactMirror cannot build
 * a mirror for a `t.Recursive` schema: it throws per route, logs the whole
 * schema, and falls back to slow per-request serialization on every hot
 * filter route. A fixed finite nesting is exactMirror-safe and still
 * rejects malformed input, while being far deeper than any real filter tree
 * a builder UI produces.
 */
const MAX_CONDITION_DEPTH = 6;

const buildBoundedNode = (): TSchema => {
  let node: TSchema = tNodeShape;
  for (let level = 1; level < MAX_CONDITION_DEPTH; level++) {
    node = t.Union([tCompare, tPredicate, tGroupWith(node)]);
  }
  return node;
};

const tConditionNodeBounded = buildBoundedNode();

/**
 * Route-contract schema. Validates with the bounded-depth structure above
 * but presents the canonical `ConditionNode` static type to Eden: a finite
 * nesting otherwise leaks its depth into TypeScript inference, while the
 * client always works with the unbounded `ConditionNode` shape.
 */
export const tConditionNode = Type.Unsafe<ConditionNode>(tConditionNodeBounded);

/** Top-level condition: always the AND/OR root group. */
export const tCondition = t.Object({
  type: t.Literal("group"),
  combinator: t.UnionEnum([...COMBINATORS]),
  negated: t.Optional(t.Boolean()),
  children: t.Array(tConditionNode),
});

// Fails typecheck if the TypeBox mirror admits a shape outside the canonical
// AST. Depth bounding only restricts nesting (a strict subset of the canonical
// tree), so checking one fully-formed level (leaf arms plus a group whose
// children are nodes) covers every shape the mirror can admit. Operators and
// fields can't drift; they're spread from the same package constants. The
// reverse direction is intentionally omitted: TypeBox optionals drop
// `| undefined` under exactOptionalPropertyTypes, so canonical->mirror would
// false-positive without guarding anything the spreads don't already.
const _mirrorToCanonical = (n: Static<typeof tNodeShape>): ConditionNode => n;
void _mirrorToCanonical;
