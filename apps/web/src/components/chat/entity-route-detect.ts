import type { CurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";

/**
 * Whether the entity is already the main view: the document page on screen
 * (`getCurrentWorkspaceDocument`) shows it in its matter. Clicking its
 * mention then surfaces metadata in the inspector rather than opening a
 * duplicate file lane that races the main view.
 */
export const isEntityActiveInMainRoute = (
  entity: { entityId: string; workspaceId: string },
  document: CurrentWorkspaceDocument,
): boolean =>
  document !== undefined &&
  document.workspaceId === entity.workspaceId &&
  document.entityId === entity.entityId;

/** Whether the main document page shows this exact file field. */
export const isFileActiveInMainRoute = (
  file: { entityId: string; fieldId: string; workspaceId: string },
  document: CurrentWorkspaceDocument,
): boolean =>
  isEntityActiveInMainRoute(file, document) &&
  document?.fieldId === file.fieldId;
