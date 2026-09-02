/**
 * The single owner of "does this leaf compile to anything at all" —
 * structural facts about a `compare`/`predicate` node's own shape that make
 * it produce no SQL restriction, independent of what it compiles *to*. The
 * API's SQL compiler (`entity-filters.ts`) and any other reader that has to
 * agree with it on which leaves survive (e.g. a client-side "what kinds does
 * this filter admit" pass) call this instead of re-deriving the rule, so the
 * two never drift apart on an in-progress or unsupported leaf.
 *
 * The rule is purely structural — decidable from the node's own shape, with
 * no database or domain lookup:
 *  - `compare`: effective only when `right` is a non-empty `literal` operand
 *    and `left` is a `property` or `builtin` operand. Every compare op
 *    (`eq`/`neq` included) against a blank literal is an in-progress filter —
 *    the operator is chosen, the value has not been entered yet, and blank
 *    equality is expressed with `is_empty` instead. A `formula` operand on
 *    either side, a non-literal `right`, or any other `left` shape
 *    (`kind`/`path`/`literal`) has no SQL transpilation.
 *  - `predicate`, by `operand.type`:
 *    - `kind`: only `op: "in"` with a non-empty payload.
 *    - `builtin`: only `in` (non-empty payload), `is_empty`, `is_not_empty`.
 *    - `property`: `is_empty`/`is_not_empty` need no payload; `contains`,
 *      `not_contains`, `starts_with`, `ends_with` need a payload that is
 *      non-blank in its string form (`[""]` coerces to `""`); `contains_all`,
 *      `in` need a non-empty array; `is_truthy` is not supported on a
 *      property at all (there is no SQL form for it, with or without a value).
 *    - `path`/`formula`/`literal`: never effective.
 *
 * What stays OUT of this predicate, by design: anything that needs context
 * the package cannot see. Whether the `kind in […]` payload actually names a
 * recognized `EntityKind` (as opposed to a stale/unknown string) depends on
 * the domain's kind enum, not on AST shape — that filtering stays in the API,
 * layered on top of this predicate's "has a payload at all" check. The same
 * goes for anything that would require knowing a property's existence or
 * declared type; this package has no such lookup, so it can only ever be
 * asked "given this node's own fields, could it possibly restrict anything."
 */
import type { CompareNode, PredicateNode, PredicateOp } from "./schema";

/** True when there is a real (non-empty) payload to test against. */
const hasPredicatePayload = (value: PredicateNode["value"]): boolean => {
  if (value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== "";
};

/**
 * The scalar text ops (`contains`, `not_contains`, `starts_with`,
 * `ends_with`) match the payload's string form: the compiler coerces the
 * value with `String(...)`, so `[""]` collapses to `""` and `["a", "b"]` to
 * `"a,b"`. A payload that is blank once coerced is an in-progress filter and
 * must not compile into a match-everything pattern.
 */
const hasScalarTextPayload = (value: PredicateNode["value"]): boolean =>
  value !== undefined && String(value) !== "";

const isEffectiveCompare = (node: CompareNode): boolean => {
  if (node.left.type === "formula" || node.right.type === "formula") {
    return false;
  }
  if (node.right.type !== "literal") {
    return false;
  }
  if (node.left.type !== "property" && node.left.type !== "builtin") {
    return false;
  }
  return String(node.right.value) !== "";
};

const isEffectiveBuiltinPredicate = (
  op: PredicateOp,
  value: PredicateNode["value"],
): boolean => {
  switch (op) {
    case "in":
      return hasPredicatePayload(value);
    case "is_empty":
    case "is_not_empty":
      return true;
    case "is_truthy":
    case "contains":
    case "not_contains":
    case "starts_with":
    case "ends_with":
    case "contains_all":
      return false;
    default:
      return op satisfies never;
  }
};

const isEffectivePropertyPredicate = (
  op: PredicateOp,
  value: PredicateNode["value"],
): boolean => {
  switch (op) {
    case "is_empty":
    case "is_not_empty":
      return true;
    case "is_truthy":
      return false;
    case "contains":
    case "not_contains":
    case "starts_with":
    case "ends_with":
      return hasScalarTextPayload(value);
    case "contains_all":
    case "in":
      return hasPredicatePayload(value);
    default:
      return op satisfies never;
  }
};

const isEffectivePredicate = (node: PredicateNode): boolean => {
  switch (node.operand.type) {
    case "kind":
      return node.op === "in" && hasPredicatePayload(node.value);
    case "builtin":
      return isEffectiveBuiltinPredicate(node.op, node.value);
    case "property":
      return isEffectivePropertyPredicate(node.op, node.value);
    case "path":
    case "formula":
    case "literal":
      return false;
    default:
      return node.operand satisfies never;
  }
};

/**
 * Whether a leaf's own shape lets it compile to a real SQL restriction. See
 * the module doc comment for the exact rule and its deliberate boundary.
 *
 * A `false` result means the leaf compiles to nothing (an incomplete filter,
 * or a shape SQL does not support) and should be dropped exactly like a
 * `fold` leaf handler returning `null` — never treated as "matches
 * everything," which would wrongly widen an `or` around it.
 */
export const isEffectiveLeaf = (node: CompareNode | PredicateNode): boolean =>
  node.type === "compare"
    ? isEffectiveCompare(node)
    : isEffectivePredicate(node);
