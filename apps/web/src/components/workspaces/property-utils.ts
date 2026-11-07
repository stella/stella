import {
  emptyColor,
  optionColors,
  resolveOptionColor,
} from "@stll/ui/option-color";
import type { ColumnSortKind } from "@stll/workspace-ui/column-sort";

import type { PropertyComposerContentType } from "@/components/workspaces/properties/composer-primitives";
import type { ActionDescriptor } from "@/lib/organization/feature-access/action-capabilities.logic";
import type { WorkspaceProperty } from "@/lib/types";

const PROPERTY_TOOL_ACTIONS = {
  "manual-input": { capability: null },
  "ai-model": { capability: "ai" },
  "playbook-verdict": { capability: "ai" },
} as const satisfies Record<
  WorkspaceProperty["tool"]["type"],
  ActionDescriptor
>;

export const propertyToolAction = (
  toolType: WorkspaceProperty["tool"]["type"] | undefined,
) => PROPERTY_TOOL_ACTIONS[toolType ?? "ai-model"];

export const isPropertyComposerContentType = (
  t: string,
): t is PropertyComposerContentType =>
  t === "money" ||
  t === "text" ||
  t === "single-select" ||
  t === "multi-select" ||
  t === "date" ||
  t === "int";

/**
 * What a property's column orders by. Total over the content types, so a new
 * type does not compile until it says how its header labels its order. A
 * select, a person and a file order by the name they show; money by amount.
 */
export const PROPERTY_SORT_KINDS = {
  file: "text",
  text: "text",
  "single-select": "text",
  "multi-select": "text",
  date: "date",
  int: "number",
  money: "number",
  person: "text",
  // A record has no single value to order by; its projection columns do.
  record: null,
} as const satisfies Record<
  WorkspaceProperty["content"]["type"],
  ColumnSortKind | null
>;

export type { ColorVariants } from "@stll/ui/option-color";
export { emptyColor, optionColors, resolveOptionColor };
