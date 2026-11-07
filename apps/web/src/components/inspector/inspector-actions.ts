import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  definedFields,
  type InspectorOpenArgs,
  planInspectorOpen,
  toFileTab,
} from "@/components/inspector/open-entities.logic";
import { getEntityName } from "@/components/workspaces/entity-utils";
import type { WorkspaceEntity } from "@/lib/types";

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

type OpenFilePreviewArgs = {
  entity: WorkspaceEntity;
  /** The file field to show; its id is the tab's. */
  fieldId: string;
  workspaceId: string;
};

/**
 * Show one file of `entity` in the inspector, on its preview: the pages a
 * PDF's signature stamp is placed on. Opens nothing when the entity has no
 * displayable file under `fieldId`.
 */
export const openInspectorFilePreview = ({
  entity,
  fieldId,
  workspaceId,
}: OpenFilePreviewArgs): void => {
  const tab = toFileTab({
    entityId: entity.entityId,
    fields: definedFields(entity).filter((field) => field.id === fieldId),
    label: getEntityName(entity),
    workspaceId,
  });
  if (tab === null) {
    return;
  }
  const tabs = useInspectorTabsStore.getState();
  tabs.openFile(tab);
  tabs.setFileFacet(tab.id, "preview");
};
