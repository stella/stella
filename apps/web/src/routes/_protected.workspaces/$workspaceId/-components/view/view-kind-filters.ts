import { conditionIncludesKind } from "@stll/conditions";
import type { ConditionNode } from "@stll/conditions";

/**
 * A task kind filter marks a saved view as a List. Kind filters are restricted
 * to one top-level predicate by the API, so this deliberately does not walk
 * nested condition groups.
 */
export const includesListItems = (filters: readonly ConditionNode[]): boolean =>
  conditionIncludesKind(filters, "task");
