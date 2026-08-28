import type {
  FileTab,
  InspectorOpenTarget,
  OpenTabsArgs,
} from "@/components/inspector/inspector-store-types";
import { getEntityName } from "@/components/workspaces/entity-utils";
import {
  isFileDisplayable,
  type WorkspaceEntity,
  type WorkspaceFieldContent,
} from "@/lib/types";

/** The subset of a field the projection needs; `entityId` is passed
 *  separately because chat mentions carry fields without it. */
export type FileTabSourceField = {
  id: string;
  propertyId?: string | undefined;
  content: WorkspaceFieldContent;
};

type ToFileTabArgs = {
  entityId: string;
  fields: Iterable<FileTabSourceField>;
  label: string;
  workspaceId: string;
};

/** The file tab for an entity's first displayable file field, or null when
 *  it has none. The single owner of the entity-to-file-tab projection: a
 *  non-displayable file ahead of a displayable one does not hide the latter. */
export const toFileTab = ({
  entityId,
  fields,
  label,
  workspaceId,
}: ToFileTabArgs): Omit<FileTab, "type"> | null => {
  for (const field of fields) {
    if (field.content.type !== "file" || !isFileDisplayable(field.content)) {
      continue;
    }
    return {
      id: field.id,
      entityId,
      label,
      fileName: field.content.fileName,
      mimeType: field.content.mimeType,
      pdfFileId: field.content.pdfFileId,
      propertyId: field.propertyId,
      workspaceId,
    };
  }
  return null;
};

export const definedFields = (
  entity: WorkspaceEntity,
): FileTabSourceField[] => {
  const fields: FileTabSourceField[] = [];
  for (const field of Object.values(entity.fields)) {
    if (field) {
      fields.push(field);
    }
  }
  return fields;
};

const toInspectorOpenTarget = (
  entity: WorkspaceEntity,
  workspaceId: string,
): InspectorOpenTarget | null => {
  const label = getEntityName(entity);
  if (entity.kind === "task") {
    return {
      type: "task",
      id: entity.entityId,
      creationStatus: "ready",
      label,
      isNew: false,
      workspaceId,
    };
  }
  const fileTab = toFileTab({
    entityId: entity.entityId,
    fields: definedFields(entity),
    label,
    workspaceId,
  });
  return fileTab === null ? null : { type: "pdf", ...fileTab };
};

export type InspectorOpenArgs = {
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
}: InspectorOpenArgs): OpenTabsArgs | null => {
  const targets: InspectorOpenTarget[] = [];
  let anchorTargetId: string | undefined;
  for (const entity of entities) {
    const target = toInspectorOpenTarget(entity, workspaceId);
    if (target === null) {
      continue;
    }
    targets.push(target);
    if (entity.entityId === anchor.entityId) {
      anchorTargetId = target.id;
    }
  }
  const activeId = anchorTargetId ?? targets.at(0)?.id;
  return activeId === undefined ? null : { targets, activeId };
};
