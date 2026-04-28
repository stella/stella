import { toastManager } from "@stella/ui/components/toast";

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

/** Open the entity's file in the inspector panel. */
export const openEntityInInspector = async (
  entityId: string,
  label: string,
  workspaceId = "",
  entity?: WorkspaceEntity,
) => {
  if (!workspaceId) {
    return;
  }

  if (entity !== undefined) {
    openDisplayableFile({
      entityId,
      fields: toEntityFileFields(entity),
      label,
      workspaceId,
    });
    return;
  }

  try {
    const response = await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .entity({ entityId: toSafeId<"entity">(entityId) })
      .get();

    if (response.error) {
      throw toAPIError(response.error);
    }

    const opened = openDisplayableFile({
      entityId,
      fields: response.data.fields,
      label: response.data.name ?? label,
      workspaceId,
    });

    if (!opened) {
      const t = getTranslator();
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    }
  } catch (error) {
    getAnalytics().captureError(error);
    const t = getTranslator();
    toastManager.add({
      title: error instanceof Error ? error.message : t("errors.actionFailed"),
      type: "error",
    });
  }
};
