import { isEntityKind } from "@stll/api-contract";
import { conditionIncludesKind } from "@stll/conditions";
import type { ConditionNode } from "@stll/conditions";

import type { EntityKind } from "@/lib/types";

/**
 * A task kind filter marks a saved view as a List, including predicates nested
 * in condition groups.
 */
export const includesListItems = (filters: readonly ConditionNode[]): boolean =>
  conditionIncludesKind(filters, "task");

/**
 * The entity kinds a view's filters admit, read from its `kind in […]`
 * predicates (nested groups included), or `null` when the view does not
 * restrict the kind. A view that names kinds only ever shows those entities,
 * so anything offered per property (calculations, columns) can be scoped to
 * the properties those kinds carry.
 */
export const viewEntityKinds = (
  filters: readonly ConditionNode[],
): readonly EntityKind[] | null => {
  const kinds = new Set<EntityKind>();
  return collectViewKinds(filters, kinds) ? [...kinds] : null;
};

/** Adds every admitted kind to `kinds`; true when some predicate restricts it. */
const collectViewKinds = (
  nodes: readonly ConditionNode[],
  kinds: Set<EntityKind>,
): boolean => {
  let restricted = false;
  for (const node of nodes) {
    if (node.type === "group") {
      restricted = collectViewKinds(node.children, kinds) || restricted;
      continue;
    }
    if (
      node.type !== "predicate" ||
      node.operand.type !== "kind" ||
      node.op !== "in" ||
      !Array.isArray(node.value)
    ) {
      continue;
    }
    restricted = true;
    for (const value of node.value) {
      if (typeof value === "string" && isEntityKind(value)) {
        kinds.add(value);
      }
    }
  }
  return restricted;
};
