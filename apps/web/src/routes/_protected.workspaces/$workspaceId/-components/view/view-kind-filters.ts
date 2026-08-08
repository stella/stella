import { conditionIncludesKind } from "@stll/conditions";
import type { ConditionNode } from "@stll/conditions";

/**
 * A task kind filter marks a saved view as a List, including predicates nested
 * in condition groups.
 */
export const includesListItems = (filters: readonly ConditionNode[]): boolean =>
  conditionIncludesKind(filters, "task");
