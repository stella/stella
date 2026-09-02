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
 *
 * The rules mirror how the API compiles a filter to SQL: a group with no
 * compiled children is dropped, and never counts as a restriction or as an
 * "everything" branch of its parent; an `and` intersects the sets its
 * restricted children admit (an unrestricted child is ignored); an `or` is
 * restricted only when every remaining child is, and is then their union;
 * a negated group, and any predicate or compare node other than
 * `kind in […]`, is unrestricted: we do not compute the complement a negation
 * would admit.
 */
export const viewEntityKinds = (
  filters: readonly ConditionNode[],
): readonly EntityKind[] | null => {
  const admitted = admittedKindsForAnd(filters);
  return admitted.type === "kinds" ? [...admitted.kinds] : null;
};

/**
 * What a node contributes to the kinds a view admits. `dropped` is a node
 * the query compiler discards (an empty group, recursively), which must not
 * be confused with `unrestricted`: an `or` over a task restriction and a
 * dropped group still shows only tasks.
 */
type AdmittedKinds =
  | { type: "dropped" }
  | { type: "unrestricted" }
  | { type: "kinds"; kinds: ReadonlySet<EntityKind> };

const DROPPED = { type: "dropped" } as const satisfies AdmittedKinds;
const UNRESTRICTED = {
  type: "unrestricted",
} as const satisfies AdmittedKinds;

const admittedKinds = (node: ConditionNode): AdmittedKinds => {
  switch (node.type) {
    case "compare":
      return UNRESTRICTED;
    case "predicate":
      return admittedKindsForPredicate(node);
    case "group":
      return admittedKindsForGroup(node);
    default:
      return node satisfies never;
  }
};

const admittedKindsForPredicate = (node: PredicateNode): AdmittedKinds => {
  if (
    node.operand.type !== "kind" ||
    node.op !== "in" ||
    !Array.isArray(node.value)
  ) {
    return UNRESTRICTED;
  }
  const kinds = new Set<EntityKind>();
  for (const value of node.value) {
    if (isEntityKind(value)) {
      kinds.add(value);
    }
  }
  return { type: "kinds", kinds };
};

const admittedKindsForGroup = (node: GroupNode): AdmittedKinds => {
  const children = node.children
    .map(admittedKinds)
    .filter((child) => child.type !== "dropped");
  if (children.length === 0) {
    return DROPPED;
  }
  if (node.negated) {
    return UNRESTRICTED;
  }
  switch (node.combinator) {
    case "and":
      return combineAnd(children);
    case "or":
      return combineOr(children);
    default:
      return node.combinator satisfies never;
  }
};

/** The implicit `and` over a filter list; an all-dropped list restricts nothing. */
const admittedKindsForAnd = (nodes: readonly ConditionNode[]): AdmittedKinds =>
  combineAnd(
    nodes.map(admittedKinds).filter((child) => child.type !== "dropped"),
  );

/** Intersection of restricted children; unrestricted children are ignored. */
const combineAnd = (children: readonly AdmittedKinds[]): AdmittedKinds => {
  let result: ReadonlySet<EntityKind> | null = null;
  for (const child of children) {
    if (child.type !== "kinds") {
      continue;
    }
    result = result ? intersect(result, child.kinds) : child.kinds;
  }
  return result ? { type: "kinds", kinds: result } : UNRESTRICTED;
};

/** Union of children, but only when every child is itself restricted. */
const combineOr = (children: readonly AdmittedKinds[]): AdmittedKinds => {
  const kinds = new Set<EntityKind>();
  for (const child of children) {
    if (child.type !== "kinds") {
      return UNRESTRICTED;
    }
    for (const kind of child.kinds) {
      kinds.add(kind);
    }
  }
  return { type: "kinds", kinds };
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
