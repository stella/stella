import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { planInspectorOpen } from "@/components/inspector/open-entities.logic";
import type { WorkspaceEntity } from "@/lib/types";

/** Activate a tab, then queue its rename command for the lazy tab consumer. */
export const requestInspectorRename = (tabId: string): void => {
  useInspectorTabsStore.getState().setActive(tabId);
  useInspectorCommandStore.getState().requestRename(tabId);
};

type InspectorOpenSelectionArgs = {
  entities: readonly WorkspaceEntity[];
  /** The row the user acted on; its tab takes focus. */
  anchor: WorkspaceEntity;
  workspaceId: string;
};

/** The open handler for a selection, or undefined when nothing in it can
 *  open (which is what hides the Preview action). */
export const openInspectorSelection = ({
  entities,
  anchor,
  workspaceId,
}: InspectorOpenSelectionArgs): (() => void) | undefined => {
  const plan = planInspectorOpen({ entities, anchor, workspaceId });
  if (plan === null) {
    return undefined;
  }
  return () => useInspectorTabsStore.getState().openTabs(plan);
};
