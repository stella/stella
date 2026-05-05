import { stellaToast } from "@stll/ui/components/toast";

import { isEntityActiveInMainRoute } from "@/components/chat/entity-route-detect";
import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { isFileDisplayable } from "@/lib/types";
import type { WorkspaceEntity, WorkspaceFieldContent } from "@/lib/types";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

type EntityFileField = {
  id: string;
  propertyId?: string | undefined;
  content: WorkspaceFieldContent;
};

const openDisplayableFile = ({
  entityId,
  fields,
  label,
  workspaceId,
}: {
  entityId: string;
  fields: Iterable<EntityFileField>;
  label: string;
  workspaceId: string;
}) => {
  const sameAsMainRoute = isEntityActiveInMainRoute(entityId, workspaceId);

  for (const field of fields) {
    if (field.content.type !== "file" || !isFileDisplayable(field.content)) {
      continue;
    }

    useInspectorStore.getState().openPdf({
      id: field.id,
      entityId,
      label,
      mimeType: field.content.mimeType,
      pdfFileId: field.content.pdfFileId,
      propertyId: field.propertyId,
      workspaceId,
      // The file is already in the main view; don't compete with
      // it — open the inspector to its metadata view so the
      // mention click reveals fields/properties instead of
      // re-rendering the same document.
      ...(sameAsMainRoute ? { metadataLane: "expanded" as const } : {}),
    });
    return true;
  }

  return false;
};

const toEntityFileFields = (entity: WorkspaceEntity): EntityFileField[] =>
  Object.entries(entity.fields).map(([propertyId, field]) => ({
    id: field.id,
    propertyId,
    content: field.content,
  }));

type OpenEntityResult =
  | { type: "opened" }
  | { type: "folder"; entityId: string; workspaceId: string }
  | { type: "unsupported" };

const openEntityByKind = ({
  entityId,
  kind,
  label,
  workspaceId,
}: {
  entityId: string;
  kind: string;
  label: string;
  workspaceId: string;
}): OpenEntityResult | null => {
  if (kind === "task") {
    useInspectorStore.getState().openTask(entityId, label);
    return { type: "opened" };
  }

  if (kind === "folder") {
    return { type: "folder", entityId, workspaceId };
  }

  return null;
};

/** Open an entity reference from chat. Documents open in the
 *  file inspector, tasks open in the task inspector, and folders
 *  are returned to the caller for route-level navigation. */
export const openEntityInInspector = async (
  entityId: string,
  label: string,
  workspaceId = "",
  entity?: WorkspaceEntity,
): Promise<OpenEntityResult> => {
  if (!workspaceId) {
    return { type: "unsupported" };
  }

  if (entity !== undefined) {
    const openedByKind = openEntityByKind({
      entityId,
      kind: entity.kind,
      label,
      workspaceId,
    });
    if (openedByKind) {
      return openedByKind;
    }

    openDisplayableFile({
      entityId,
      fields: toEntityFileFields(entity),
      label,
      workspaceId,
    });
    return { type: "opened" };
  }

  try {
    const response = await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .entity({ entityId: toSafeId<"entity">(entityId) })
      .get();

    if (response.error) {
      throw toAPIError(response.error);
    }

    const responseLabel = response.data.name ?? label;
    const openedByKind = openEntityByKind({
      entityId,
      kind: response.data.kind,
      label: responseLabel,
      workspaceId,
    });
    if (openedByKind) {
      return openedByKind;
    }

    const opened = openDisplayableFile({
      entityId,
      fields: response.data.fields,
      label: responseLabel,
      workspaceId,
    });

    if (opened) {
      return { type: "opened" };
    }

    const t = getTranslator();
    stellaToast.add({
      title: t("errors.actionFailed"),
      type: "error",
    });
    return { type: "unsupported" };
  } catch (error) {
    getAnalytics().captureError(error);
    const t = getTranslator();
    stellaToast.add({
      title: error instanceof Error ? error.message : t("errors.actionFailed"),
      type: "error",
    });
    return { type: "unsupported" };
  }
};
