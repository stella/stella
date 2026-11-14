import {
  emptyColor,
  optionColors,
  resolveOptionColor,
} from "@stll/ui/option-color";

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

export type { ColorVariants } from "@stll/ui/option-color";
export { emptyColor, optionColors, resolveOptionColor };
