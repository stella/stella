import { isEntityKind } from "@stll/api-contract";
import {
  conditionIncludesKind,
  foldConditions,
  isEffectiveLeaf,
} from "@stll/conditions";
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
 * Whether a view's filters provably restrict it to the `task` kind alone.
 * The kanban board's assignee sub-group is offered only then: server paging
 * and counts for that sub-group do not support a board that also admits
 * documents or folders (see kanban-view.logic.ts's `assigneeGroup`).
 */
export const admitsOnlyTaskKind = (
  filters: readonly ConditionNode[],
): boolean => {
  const kinds = viewEntityKinds(filters);
  return kinds?.length === 1 && kinds[0] === "task";
};

/**
 * What a node contributes to the kinds a view admits. Unlike the fold's
 * generic drop rule (a `null` result), a *compiling* predicate or compare
 * other than `kind in […]` never reports "dropped" — it still restricts SQL
 * rows, just not by kind, so it folds to `UNRESTRICTED` rather than `null`.
 * A leaf `isEffectiveLeaf` rejects (an incomplete filter, or a shape the SQL
 * compiler does not support) genuinely IS dropped here too, exactly as it is
 * dropped from the compiled SQL — see `isEffectiveLeaf`'s doc comment for the
 * shared rule. An empty group is dropped the same way, but that is handled
 * by the fold itself before `group` below is called.
 */
type AdmittedKinds =
  | { type: "unrestricted" }
  | { type: "kinds"; kinds: ReadonlySet<EntityKind> };

const UNRESTRICTED = {
  type: "unrestricted",
} as const satisfies AdmittedKinds;

const admittedKindsForLeaf: FoldHandlers<AdmittedKinds>["leaf"] = (node) => {
  if (!isEffectiveLeaf(node)) {
    return null;
  }
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
