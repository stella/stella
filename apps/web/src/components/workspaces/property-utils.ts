import {
  emptyColor,
  optionColors,
  resolveOptionColor,
} from "@stll/ui/option-color";

import type { CreatableContentType } from "@/components/workspaces/properties/composer-primitives";
import type { SortHint } from "@/components/workspaces/properties/sort-property";
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

/** Map a property content type to a sort hint. */
export const toSortHint = (contentType: string): SortHint => {
  switch (contentType) {
    case "date":
      return "date";
    case "int":
      return "number";
    default:
      return "text";
  }
};

export type { ColorVariants } from "@stll/ui/option-color";
export { emptyColor, optionColors, resolveOptionColor };
