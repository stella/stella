import { isEntityKind } from "@stll/api-contract";
import { conditionIncludesKind } from "@stll/conditions";
import type { ConditionNode, GroupNode, PredicateNode } from "@stll/conditions";

import type { EntityKind } from "@/lib/types";

/**
 * A task kind filter marks a saved view as a List, including predicates nested
 * in condition groups.
 */
export const includesListItems = (filters: readonly ConditionNode[]): boolean =>
  conditionIncludesKind(filters, "task");

/**
 * The entity kinds a view's filters admit, read from its `kind in […]`
 * predicates, or `null` when the view does not provably restrict the kind.
 * An `and` intersects the sets its restricted children admit (an unrestricted
 * child is ignored, not treated as "everything"); an `or` is restricted only
 * when every child is, and is then their union. A negated group, and any
 * predicate or compare node other than `kind in […]`, is treated as
 * unrestricted: we do not compute the complement a negation would admit.
 */
export const viewEntityKinds = (
  filters: readonly ConditionNode[],
): readonly EntityKind[] | null => {
  const kinds = admittedKindsForAnd(filters);
  return kinds ? [...kinds] : null;
};

/** The kinds a single condition node admits, or `null` when unrestricted. */
const admittedKinds = (node: ConditionNode): ReadonlySet<EntityKind> | null => {
  switch (node.type) {
    case "compare":
      return null;
    case "predicate":
      return admittedKindsForPredicate(node);
    case "group":
      return admittedKindsForGroup(node);
    default:
      return node satisfies never;
  }
};

const admittedKindsForPredicate = (
  node: PredicateNode,
): ReadonlySet<EntityKind> | null => {
  if (
    node.operand.type !== "kind" ||
    node.op !== "in" ||
    !Array.isArray(node.value)
  ) {
    return null;
  }
  const kinds = new Set<EntityKind>();
  for (const value of node.value) {
    if (isEntityKind(value)) {
      kinds.add(value);
    }
  }
  return kinds;
};

const admittedKindsForGroup = (
  node: GroupNode,
): ReadonlySet<EntityKind> | null => {
  if (node.negated) {
    return null;
  }
  switch (node.combinator) {
    case "and":
      return admittedKindsForAnd(node.children);
    case "or":
      return admittedKindsForOr(node.children);
    default:
      return node.combinator satisfies never;
  }
};

/** Intersection of restricted children; unrestricted children are ignored. */
const admittedKindsForAnd = (
  nodes: readonly ConditionNode[],
): ReadonlySet<EntityKind> | null => {
  let result: ReadonlySet<EntityKind> | null = null;
  for (const node of nodes) {
    const childKinds = admittedKinds(node);
    if (!childKinds) {
      continue;
    }
    result = result ? intersect(result, childKinds) : childKinds;
  }
  return result;
};

/**
 * Union of children, but only when every child is itself restricted. An `or`
 * with no children admits everything: the filter builder can leave such a
 * group behind after its last child is removed, and the query compiler drops
 * it, so the view is unrestricted.
 */
const admittedKindsForOr = (
  nodes: readonly ConditionNode[],
): ReadonlySet<EntityKind> | null => {
  if (nodes.length === 0) {
    return null;
  }
  const kinds = new Set<EntityKind>();
  for (const node of nodes) {
    const childKinds = admittedKinds(node);
    if (!childKinds) {
      return null;
    }
    for (const kind of childKinds) {
      kinds.add(kind);
    }
  }
  return kinds;
};

const intersect = (
  a: ReadonlySet<EntityKind>,
  b: ReadonlySet<EntityKind>,
): ReadonlySet<EntityKind> => {
  const result = new Set<EntityKind>();
  for (const kind of a) {
    if (b.has(kind)) {
      result.add(kind);
    }
  }
  return result;
};
