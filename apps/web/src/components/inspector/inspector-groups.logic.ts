import { panic } from "better-result";

import type {
  InspectorTab,
  InspectorTabGroup,
  InspectorTabsState,
} from "@/components/inspector/inspector-store-types";

export const getInspectorTabMatterId = (tab: InspectorTab): string | null => {
  switch (tab.type) {
    case "pdf":
    case "task":
    case "matter":
      return tab.workspaceId;
    case "chat":
      return tab.workspaceId ?? tab.contextMatterIds.at(0) ?? null;
    case "external":
      return tab.workspaceId;
    case "skill-resource":
    case "view":
      return null;
    default:
      tab satisfies never;
      return panic("Unhandled inspector tab type");
  }
};

export const normalizeInspectorGroupAssignments = (
  tabs: readonly InspectorTab[],
  groups: readonly InspectorTabGroup[],
  assignments: Readonly<Record<string, string | null>>,
): Record<string, string | null> => {
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const groupIds = new Set(groups.map((group) => group.id));
  for (const tab of tabs) {
    const matterId = getInspectorTabMatterId(tab);
    if (matterId !== null) {
      groupIds.add(`matter:${matterId}`);
    }
  }
  return Object.fromEntries(
    Object.entries(assignments)
      .filter(([tabId]) => tabIds.has(tabId))
      .map(([tabId, groupId]) => [
        tabId,
        groupId === null ||
        groupIds.has(groupId) ||
        (groupId.startsWith("matter:") && groupId.length > "matter:".length)
          ? groupId
          : null,
      ]),
  );
};

export const getInspectorTabGroupId = (
  state: Pick<InspectorTabsState, "groupAssignments">,
  tab: InspectorTab,
): string | null => {
  if (Object.hasOwn(state.groupAssignments, tab.id)) {
    return state.groupAssignments[tab.id] ?? null;
  }
  const matterId = getInspectorTabMatterId(tab);
  return matterId === null ? null : `matter:${matterId}`;
};

type InspectorTabDropOptions = {
  state: Pick<InspectorTabsState, "tabs" | "groupAssignments">;
  sourceId: string;
  targetId: string;
};

export const planInspectorTabDrop = ({
  state,
  sourceId,
  targetId,
}: InspectorTabDropOptions):
  | { type: "ignore" }
  | { type: "join"; groupId: string }
  | { type: "create"; name: string } => {
  const source = state.tabs.find((tab) => tab.id === sourceId);
  const target = state.tabs.find((tab) => tab.id === targetId);
  if (source === undefined || target === undefined || sourceId === targetId) {
    return { type: "ignore" };
  }
  const groupId = getInspectorTabGroupId(state, target);
  if (groupId === null) {
    return { type: "create", name: target.label };
  }
  return getInspectorTabGroupId(state, source) === groupId
    ? { type: "ignore" }
    : { type: "join", groupId };
};
