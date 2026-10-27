import type { ColumnSortKind } from "@stll/api-contract/column-sort";
import {
  emptyColor,
  optionColors,
  resolveOptionColor,
} from "@stll/ui/option-color";

import type { CreatableContentType } from "@/components/workspaces/properties/composer-primitives";
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

export const isCreatableContentType = (t: string): t is CreatableContentType =>
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
} as const satisfies Record<
  WorkspaceProperty["content"]["type"],
  ColumnSortKind
>;

export type { ColorVariants } from "@stll/ui/option-color";
export { emptyColor, optionColors, resolveOptionColor };
