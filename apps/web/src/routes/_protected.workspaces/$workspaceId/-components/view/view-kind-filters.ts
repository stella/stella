import { isEntityKind } from "@stll/api-contract";
import { conditionIncludesKind, foldConditions } from "@stll/conditions";
import type { ConditionNode, FoldHandlers } from "@stll/conditions";

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
 * The rules mirror how the API compiles a filter to SQL (`@stll/conditions`'s
 * `foldCondition`/`foldConditions` own that structural agreement): a group
 * with no compiled children is dropped, and never counts as a restriction or
 * as an "everything" branch of its parent; an `and` intersects the sets its
 * restricted children admit (an unrestricted child is ignored); an `or` is
 * restricted only when every remaining child is, and is then their union;
 * a negated group, and any predicate or compare node other than
 * `kind in […]`, is unrestricted: we do not compute the complement a negation
 * would admit.
 */
export const viewEntityKinds = (
  filters: readonly ConditionNode[],
): readonly EntityKind[] | null => {
  // A filter whose nodes are all dropped restricts nothing.
  const survivors = foldConditions(filters, kindFoldHandlers);
  if (survivors === null) {
    return null;
  }
  const admitted = combineAnd(survivors);
  return admitted.type === "kinds" ? [...admitted.kinds] : null;
};

/**
 * What a node contributes to the kinds a view admits. Unlike the fold's
 * generic drop rule (a `null` result), this never reports "dropped" — a
 * predicate or compare other than `kind in […]` still compiles to SQL, it
 * just does not restrict which kind rows match, so it folds to
 * `UNRESTRICTED` rather than `null`. Only an empty group is ever dropped,
 * and that is handled by the fold itself before `group` below is called.
 */
type AdmittedKinds =
  | { type: "unrestricted" }
  | { type: "kinds"; kinds: ReadonlySet<EntityKind> };

const UNRESTRICTED = {
  type: "unrestricted",
} as const satisfies AdmittedKinds;

const admittedKindsForLeaf: FoldHandlers<AdmittedKinds>["leaf"] = (node) => {
  if (
    node.type !== "predicate" ||
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

const admittedKindsForGroup: FoldHandlers<AdmittedKinds>["group"] = (
  node,
  children,
) => {
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

const kindFoldHandlers: FoldHandlers<AdmittedKinds> = {
  leaf: admittedKindsForLeaf,
  group: admittedKindsForGroup,
};

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
