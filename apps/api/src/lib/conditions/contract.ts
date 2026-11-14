/**
 * Route-contract mirror of the canonical `@stll/conditions` AST.
 * The schema in the package stays the source of truth for general
 * runtime validation; the route contract is narrower: its operands
 * are the ones a filter route resolves, and a group's children and
 * nesting are bounded. The parity guard below fails typecheck if
 * the mirror admits a shape outside the canonical AST.
 */
import * as v from "valibot";

import { VIEW_FILTERS_MAX } from "@stll/api-contract";
import {
  BUILTIN_FIELDS,
  COMBINATORS,
  COMPARE_OPS,
  type ConditionNode,
  PREDICATE_OPS,
} from "@stll/conditions";

const tOperand = v.union([
  v.object({
    type: v.literal("property"),
    propertyId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    type: v.literal("builtin"),
    field: v.picklist([...BUILTIN_FIELDS]),
  }),
  v.object({ type: v.literal("kind") }),
  v.object({
    type: v.literal("path"),
    path: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    type: v.literal("literal"),
    value: v.union([v.string(), v.number(), v.boolean(), v.array(v.string())]),
  }),
]);

const tCompare = v.object({
  type: v.literal("compare"),
  left: tOperand,
  op: v.picklist([...COMPARE_OPS]),
  right: tOperand,
});

const tPredicate = v.object({
  type: v.literal("predicate"),
  operand: tOperand,
  op: v.picklist([...PREDICATE_OPS]),
  value: v.optional(v.union([v.string(), v.array(v.string()), v.undefined()])),
});

const tLeaf = v.union([tCompare, tPredicate]);

/**
 * Children one group may hold. The depth bound below limits nesting only; a
 * single group could otherwise fan out to an unbounded list, so the total
 * size of one tree is bounded by this per-level cap raised to the depth.
 */
const MAX_GROUP_CHILDREN = VIEW_FILTERS_MAX;

const tGroupWith = <C extends v.GenericSchema>(children: C) =>
  v.object({
    type: v.literal("group"),
    combinator: v.picklist([...COMBINATORS]),
    negated: v.optional(v.union([v.boolean(), v.undefined()])),
    children: v.pipe(v.array(children), v.maxLength(MAX_GROUP_CHILDREN)),
  });

/**
 * One non-recursive level: the leaf arms plus a group whose children are
 * leaves. Reused as both the innermost level of the bounded schema and the
 * static-type reference for the canonical-parity guard below.
 */
const tNodeShape = v.union([tCompare, tPredicate, tGroupWith(tLeaf)]);

/**
 * Maximum group-nesting depth the route contract validates. The canonical
 * `@stll/conditions` AST is unbounded; a fixed finite nesting still rejects
 * malformed input and bounds the tree one request can send, while being far
 * deeper than any real filter tree a builder UI produces.
 */
const MAX_CONDITION_DEPTH = 6;

/**
 * Route-contract schema. Validates with the bounded-depth structure built
 * here but presents the canonical `ConditionNode` static type: a finite
 * nesting otherwise leaks its depth into TypeScript inference, while the
 * client always works with the unbounded `ConditionNode` shape. Every level
 * is a `ConditionNode`, so the annotation holds without an assertion.
 */
const buildBoundedNode = (): v.GenericSchema<unknown, ConditionNode> => {
  let node: v.GenericSchema<unknown, ConditionNode> = tNodeShape;
  for (let level = 1; level < MAX_CONDITION_DEPTH; level++) {
    node = v.union([tCompare, tPredicate, tGroupWith(node)]);
  }
  return node;
};

export const tConditionNode = buildBoundedNode();

/** Top-level condition: always the AND/OR root group. */
export const tCondition = v.object({
  type: v.literal("group"),
  combinator: v.picklist([...COMBINATORS]),
  negated: v.optional(v.boolean()),
  children: v.pipe(v.array(tConditionNode), v.maxLength(MAX_GROUP_CHILDREN)),
});

// Fails typecheck if the mirror admits a shape outside the canonical AST.
// Depth bounding only restricts nesting (a strict subset of the canonical
// tree), so checking one fully-formed level (leaf arms plus a group whose
// children are nodes) covers every shape the mirror can admit. Operators and
// fields can't drift; they're spread from the same package constants. The
// reverse direction is intentionally omitted: the canonical AST admits
// operands the route contract does not (`formula`), so canonical->mirror
// fails by design.
true satisfies [v.InferOutput<typeof tNodeShape>] extends [ConditionNode]
  ? true
  : false;
