import type {
  InspectorOpenTarget,
  OpenTabsArgs,
} from "@/components/inspector/inspector-store-types";
import {
  getEntityName,
  getFirstFile,
} from "@/components/workspaces/entity-utils";
import { isFileDisplayable, type WorkspaceEntity } from "@/lib/types";

/** Project a selection onto the inspector tabs it can open, in the order
 *  given. Folders and files the inspector cannot render are dropped. */
export const toInspectorOpenTargets = (
  entities: readonly WorkspaceEntity[],
  workspaceId: string,
): readonly InspectorOpenTarget[] => {
  const targets: InspectorOpenTarget[] = [];
  for (const entity of entities) {
    if (entity.kind === "task") {
      targets.push({
        type: "task",
        id: entity.entityId,
        creationStatus: "ready",
        label: getEntityName(entity),
        isNew: false,
        workspaceId,
      });
      continue;
    }
    const file = getFirstFile(entity);
    if (!file || !isFileDisplayable(file)) {
      continue;
    }
    targets.push({
      type: "pdf",
      id: file.fieldId,
      entityId: file.entityId,
      label: getEntityName(entity),
      fileName: file.fileName,
      mimeType: file.mimeType,
      pdfFileId: file.pdfFileId,
      propertyId: file.propertyId,
      workspaceId,
    });
  }
  return targets;
};

type InspectorOpenPlanArgs = {
  entities: readonly WorkspaceEntity[];
  /** The row the user acted on; its tab takes focus. */
  anchor: WorkspaceEntity;
  workspaceId: string;
};

/** The `openTabs` call for a selection, or null when nothing in it opens.
 *  Both the table and the tree route through here so the two surfaces
 *  cannot drift on which entities open or which tab ends up focused. */
export const planInspectorOpen = ({
  entities,
  anchor,
  workspaceId,
}: InspectorOpenPlanArgs): OpenTabsArgs | null => {
  const targets = toInspectorOpenTargets(entities, workspaceId);
  const anchorId = toInspectorOpenTargets([anchor], workspaceId).at(0)?.id;
  const activeId =
    targets.find((target) => target.id === anchorId)?.id ?? targets.at(0)?.id;
  return activeId === undefined ? null : { targets, activeId };
};
