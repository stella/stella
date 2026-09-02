/**
 * The single owner of "which condition nodes survive compilation" — the
 * structural rule that decides whether a leaf or group contributes anything
 * at all, independent of what it is compiled *to*. Every consumer that reads
 * a condition tree down to a smaller value per node (SQL, an admitted-kinds
 * set, …) must agree on this rule, or the query compiler and a client-side
 * reading of the same filter can disagree about which nodes exist.
 *
 * The rule, made explicit here instead of re-implemented per consumer:
 *  - A leaf (`compare`/`predicate`) may fold to `null`, meaning it compiles
 *    to nothing (an incomplete filter, an unsupported operator, …).
 *  - A group's `null` children are dropped before its surviving children
 *    are handed to the `group` callback, in their original order.
 *  - A group left with zero surviving children folds to `null` *without*
 *    calling `group` — the group itself is dropped, recursively, the same
 *    way an empty AND/OR compiles to no SQL. `group` never has to handle
 *    an empty `children` array.
 *  - A group may itself still fold to `null` (its `group` callback returned
 *    `null`, e.g. `and()`/`or()` of the underlying value type came back
 *    falsy) — that also drops it from its parent.
 *  - `negated` is not applied by the fold; it is passed through on the
 *    `GroupNode` so `group` can honour it (or ignore it, for callers where
 *    negation is itself something that drops the restriction, such as
 *    "what kinds does this admit").
 */
import type {
  CompareNode,
  ConditionNode,
  GroupNode,
  PredicateNode,
} from "./schema";

export type FoldHandlers<T> = {
  /** Compile a leaf node, or return `null` if it compiles to nothing. */
  leaf: (node: PredicateNode | CompareNode) => T | null;
  /**
   * Combine a group's surviving (non-`null`) children, in source order.
   * Never called with an empty `children` array — a group with no
   * surviving children is dropped before `group` would be invoked.
   */
  group: (node: GroupNode, children: readonly T[]) => T | null;
};

/**
 * Folds a single condition node per {@link FoldHandlers}. See the module
 * doc comment for the exact drop rule.
 */
export const foldCondition = <T>(
  node: ConditionNode,
  handlers: FoldHandlers<T>,
): T | null => {
  switch (node.type) {
    case "compare":
    case "predicate":
      return handlers.leaf(node);
    case "group": {
      const children: T[] = [];
      for (const child of node.children) {
        const folded = foldCondition(child, handlers);
        if (folded !== null) {
          children.push(folded);
        }
      }
      if (children.length === 0) {
        return null;
      }
      return handlers.group(node, children);
    }
    default:
      return node satisfies never;
  }
};

/**
 * Folds a top-level condition list — the implicit AND root every filter
 * array represents. Applies the same drop rule per node and returns the
 * surviving results in source order for the caller to combine (there is no
 * synthetic root `GroupNode` to hand to `group`, since a top-level list
 * carries no `combinator`/`negated` of its own). Returns `null` when every
 * node was dropped.
 */
export const foldConditions = <T>(
  nodes: readonly ConditionNode[],
  handlers: FoldHandlers<T>,
): readonly T[] | null => {
  const results: T[] = [];
  for (const node of nodes) {
    const folded = foldCondition(node, handlers);
    if (folded !== null) {
      results.push(folded);
    }
  }
  return results.length === 0 ? null : results;
};
