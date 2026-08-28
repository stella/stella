import { stellaToast } from "@stll/ui/toast";

import {
  isEntityActiveInMainRoute,
  isFileActiveInMainRoute,
} from "@/components/chat/entity-route-detect";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  definedFields,
  type FileTabSourceField,
  toFileTab,
} from "@/components/inspector/open-entities.logic";
import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import type { EmailCitationSource } from "@/lib/files/email-citations";
import type { OfficeCitationSource } from "@/lib/files/office-citations";
import { toSafeId } from "@/lib/safe-id";
import { isFileDisplayable } from "@/lib/types";
import type { WorkspaceEntity } from "@/lib/types";

const openDisplayableFile = ({
  entityId,
  fields,
  label,
  workspaceId,
  openInPreview = false,
}: {
  entityId: string;
  fields: Iterable<FileTabSourceField>;
  label: string;
  workspaceId: string;
  openInPreview?: boolean | undefined;
}) => {
  const tab = toFileTab({ entityId, fields, label, workspaceId });
  if (tab === null) {
    return false;
  }
  const sameAsMainRoute = isEntityActiveInMainRoute(entityId, workspaceId);
  useInspectorTabsStore.getState().openFile({
    ...tab,
    // The file is already in the main view; don't compete with
    // it — open the inspector to its metadata view so the
    // mention click reveals fields/properties instead of
    // re-rendering the same document.
    ...(sameAsMainRoute && !openInPreview
      ? { metadataLane: "expanded" as const }
      : {}),
  });
  return true;
};

type OpenEntityFileFieldArgs = {
  entityId: string;
  fieldId: string;
  fields: Iterable<FileTabSourceField>;
  label: string;
  workspaceId: string;
};

/** Open one exact file field instead of falling back to an entity's first
 * displayable file. Source-bound citations rely on this distinction when an
 * entity carries several attachments or representations. */
export const openEntityFileFieldInInspector = ({
  entityId,
  fieldId,
  fields,
  label,
  workspaceId,
}: OpenEntityFileFieldArgs): boolean => {
  for (const field of fields) {
    if (field.id !== fieldId) {
      continue;
    }
    const opened = openDisplayableFile({
      entityId,
      fields: [field],
      label,
      openInPreview: true,
      workspaceId,
    });
    if (opened) {
      useInspectorTabsStore.getState().setFileFacet(fieldId, "preview");
    }
    return opened;
  }
  return false;
};

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
    useInspectorTabsStore
      .getState()
      .openTask({ taskId: entityId, workspaceId, label });
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
      fields: definedFields(entity),
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

    const data = unwrapEden(response);

    const responseLabel = data.name;
    const openedByKind = openEntityByKind({
      entityId,
      kind: data.kind,
      label: responseLabel,
      workspaceId,
    });
    if (openedByKind) {
      return openedByKind;
    }

    const opened = openDisplayableFile({
      entityId,
      fields: data.fields,
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
      title: userErrorFromThrown(error, t("errors.actionFailed")),
      type: "error",
    });
    return { type: "unsupported" };
  }
};

type OpenSourceBoundEntityFileArgs = {
  entityId: string;
  entityVersionId: string;
  fieldId: string;
  isCurrent?: (() => boolean) | undefined;
  workspaceId: string;
};

/** Resolve a server-minted citation target against the current workspace and
 * open the exact field it names. The entity read is the authorization and
 * ownership check; a stale or mismatched field never falls back to a sibling
 * file, because that would make a valid citation land on the wrong source. */
export const openSourceBoundEntityFile = async ({
  entityId,
  entityVersionId,
  fieldId,
  isCurrent = () => true,
  workspaceId,
}: OpenSourceBoundEntityFileArgs): Promise<boolean> => {
  try {
    const response = await api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .entity({ entityId: toSafeId<"entity">(entityId) })
      .field({ fieldId: toSafeId<"field">(fieldId) })
      .file.get();
    const data = unwrapEden(response);
    if (
      isCurrent() &&
      data.entityVersionId === entityVersionId &&
      data.file !== null &&
      isFileDisplayable(data.file)
    ) {
      const inspector = useInspectorTabsStore.getState();
      inspector.openFile({
        id: fieldId,
        entityId,
        label: data.file.fileName,
        fileName: data.file.fileName,
        mimeType: data.file.mimeType,
        pdfFileId: data.file.pdfFileId,
        propertyId: data.file.propertyId,
        workspaceId,
      });
      inspector.setFileFacet(fieldId, "preview");
      return true;
    }

    const t = getTranslator();
    stellaToast.add({
      title: t("errors.actionFailed"),
      type: "error",
    });
    return false;
  } catch (error) {
    getAnalytics().captureError(error);
    const t = getTranslator();
    stellaToast.add({
      title: userErrorFromThrown(error, t("errors.actionFailed")),
      type: "error",
    });
    return false;
  }
};

const openFileCitationSource = ({
  source,
  workspaceId,
}: {
  source: EmailCitationSource | OfficeCitationSource;
  workspaceId: string;
}): void => {
  const inspector = useInspectorTabsStore.getState();
  const sameAsMainRoute = isFileActiveInMainRoute({
    entityId: source.entityId,
    fieldId: source.fieldId,
    workspaceId,
  });
  inspector.openFile({
    id: source.fieldId,
    entityId: source.entityId,
    label: source.entityName ?? source.fileName,
    fileName: source.fileName,
    mimeType: source.mimeType,
    pdfFileId: source.pdfFileId,
    propertyId: source.propertyId,
    workspaceId,
    ...(sameAsMainRoute ? { metadataLane: "expanded" as const } : {}),
  });
  inspector.setFileFacet(source.fieldId, "preview");
};

export const openEmailCitationSource = (options: {
  source: EmailCitationSource;
  workspaceId: string;
}): void => openFileCitationSource(options);

export const openOfficeCitationSource = (options: {
  source: OfficeCitationSource;
  workspaceId: string;
}): void => openFileCitationSource(options);
