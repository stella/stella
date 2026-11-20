import { panic } from "better-result";

import { resolveMatterColor } from "@stll/ui/matter-colors";

import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";

/**
 * The matter an inspector tab belongs to, or `undefined` for a tab that
 * belongs to no matter (a statute, a decision, a skill resource).
 */
export const getInspectorTabWorkspaceId = (
  tab: InspectorTab | undefined,
): string | undefined => {
  if (tab === undefined) {
    return undefined;
  }

  switch (tab.type) {
    case "pdf":
    case "matter":
    case "task":
      return tab.workspaceId;
    case "chat":
      return tab.workspaceId ?? tab.contextMatterIds.at(0);
    case "external":
      return tab.workspaceId ?? undefined;
    case "skill-resource":
    case "view":
      return undefined;
    default: {
      tab satisfies never;
      return panic(`Unhandled tab: ${String(tab)}`);
    }
  }
};

type InspectorMatterColorInput = {
  activeTab: InspectorTab | undefined;
  /**
   * The route's own matter colour, or `undefined` when the host does not
   * say (the matter-free tab then keeps `workspaceMatterColor`).
   */
  routeMatterColor: string | null | undefined;
  /** Colour of the matter the pane resolved for its shell affordances. */
  workspaceMatterColor: string | null;
};

/**
 * The matter colour the inspector paints its ground with. The pane paints its
 * own matter's tint, not the route's: a tab from another matter keeps that
 * matter's ground on its rail, header and panes. A tab that belongs to no
 * matter takes the route's ground instead, because the pane's resolved matter
 * may be borrowed from a background tab, and a statute opened beside a
 * matter-free chat must stay as plain as that chat.
 */
export const resolveInspectorMatterColor = ({
  activeTab,
  routeMatterColor,
  workspaceMatterColor,
}: InspectorMatterColorInput): string | null => {
  if (activeTab?.type === "matter") {
    return resolveMatterColor(activeTab.workspaceId, activeTab.color ?? null);
  }
  if (
    getInspectorTabWorkspaceId(activeTab) === undefined &&
    routeMatterColor !== undefined
  ) {
    return routeMatterColor;
  }
  return workspaceMatterColor;
};
