import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import {
  getInspectorTabsBroadcastChannelName,
  initializeInspectorTabBroadcast as initializeBroadcast,
} from "@/components/inspector/inspector-broadcast";
import type { InspectorBroadcastScope } from "@/components/inspector/inspector-broadcast";
import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import {
  buildSkillResourceTabId,
  closeTabsForDeletedEntities,
  createInspectorTabsSlice,
  isGenericInspectorTab,
} from "@/components/inspector/inspector-tabs-slice";

export type {
  ChatTab,
  CloseTabOptions,
  ExternalTab,
  ExternalTabId,
  FileFieldReplacement,
  FileTab,
  GenericTab,
  InspectorTab,
  InspectorTabsActions,
  InspectorTabsState,
  InspectorTabsStore,
  MatterTab,
  MatterTabId,
  SkillResourceTab,
  SkillResourceTabId,
  TaskTab,
} from "@/components/inspector/inspector-store-types";
export type { InspectorBroadcastScope };
export {
  buildSkillResourceTabId,
  getInspectorTabsBroadcastChannelName,
  isGenericInspectorTab,
};

export const useInspectorTabsStore = create<InspectorTabsStore>()(
  immer((set) => createInspectorTabsSlice(set)),
);

export const initializeInspectorTabBroadcast = (
  scope: InspectorBroadcastScope,
) => initializeBroadcast(useInspectorTabsStore, scope);

/** Close file and task tabs whose backing entities were deleted. */
export const closeInspectorTabsForEntities = (entityIds: string[]): void => {
  const state = useInspectorTabsStore.getState();
  const next = closeTabsForDeletedEntities(state, entityIds);
  if (
    next.tabs.length === state.tabs.length &&
    next.reviveSuggestion === state.reviveSuggestion
  ) {
    return;
  }
  useInspectorTabsStore.setState(next);
};
