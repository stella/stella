import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";

/** Activate a tab, then queue its rename command for the lazy tab consumer. */
export const requestInspectorRename = (tabId: string): void => {
  useInspectorTabsStore.getState().setActive(tabId);
  useInspectorCommandStore.getState().requestRename(tabId);
};
