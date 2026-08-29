import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  type InspectorOpenArgs,
  planInspectorOpen,
} from "@/components/inspector/open-entities.logic";

/** Activate a tab, then queue its rename command for the lazy tab consumer. */
export const requestInspectorRename = (tabId: string): void => {
  useInspectorTabsStore.getState().setActive(tabId);
  useInspectorCommandStore.getState().requestRename(tabId);
};

/** The open handler for a selection, or undefined when nothing in it can
 *  open (which is what hides the Preview action). */
export const openInspectorSelection = (
  args: InspectorOpenArgs,
): (() => void) | undefined => {
  const plan = planInspectorOpen(args);
  if (plan === null) {
    return undefined;
  }
  return () => useInspectorTabsStore.getState().openTabs(plan);
};
