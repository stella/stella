import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  EMAIL_CHAT_MODE,
  getEmailChatMode,
  getEmailExtractionRefetchInterval,
  shouldSurfaceEmailChatResolutionError,
} from "@/components/inspector/email-html-viewer.logic";
import { getEntityFileDownloadRenditions } from "@/components/inspector/file-download-service.logic";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import type { getDesktopEditFileType } from "@/lib/desktop-edit-formats";
import { entityOptions } from "@/lib/workspaces/queries/entities";

type FileTabEntityQueryInput = {
  canUpdateEntity: boolean;
  desktopEditFileType: ReturnType<typeof getDesktopEditFileType>;
  isActive: boolean;
  isEmailViewerActive: boolean;
  isPdfDisplay: boolean;
  minimized: boolean;
  needsPropertyResolution: boolean;
};

const shouldQueryFileTabEntity = ({
  canUpdateEntity,
  desktopEditFileType,
  isActive,
  isEmailViewerActive,
  isPdfDisplay,
  minimized,
  needsPropertyResolution,
}: FileTabEntityQueryInput) =>
  isEmailViewerActive ||
  needsPropertyResolution ||
  (isActive &&
    !minimized &&
    canUpdateEntity &&
    (desktopEditFileType !== null || isPdfDisplay));

const getFileTabEntityState = ({
  entityData,
  entityQueryError,
  needsPropertyResolution,
  tab,
}: {
  entityData:
    | {
        extractionFileFieldId?: string | null | undefined;
        fields: { id: string; propertyId?: string | undefined }[];
      }
    | undefined;
  entityQueryError: boolean;
  needsPropertyResolution: boolean;
  tab: FileTab;
}) => {
  const resolvedEmailChatMode = getEmailChatMode({
    extractionFileFieldId: entityData?.extractionFileFieldId,
    fieldId: tab.id,
  });
  const shouldSurfaceEmailResolutionError =
    shouldSurfaceEmailChatResolutionError({
      hasData: entityData !== undefined,
      isError: entityQueryError,
    });
  return {
    emailChatMode: shouldSurfaceEmailResolutionError
      ? EMAIL_CHAT_MODE.resolutionError
      : resolvedEmailChatMode,
    filePropertyId:
      tab.propertyId ??
      (needsPropertyResolution
        ? entityData?.fields.find((field) => field.id === tab.id)?.propertyId
        : undefined),
    resolvedEmailChatMode,
    shouldSurfaceEmailResolutionError,
  };
};

type UseFileTabEntityOptions = FileTabEntityQueryInput & { tab: FileTab };

/**
 * The file tab's entity, read only while something needs it: the email chat
 * target, the DOCX field's property, or the desktop edit and signing targets.
 */
export const useFileTabEntity = ({
  tab,
  ...queryInput
}: UseFileTabEntityOptions) => {
  // A DOCX tab opened by a caller that knows only the file field (a review's
  // reference, a search hit) still needs the field's property to mount the
  // editor; read it off the entity rather than leaving the viewer empty.
  const query = useQuery({
    ...entityOptions(tab.workspaceId, tab.entityId),
    enabled: shouldQueryFileTabEntity(queryInput),
    refetchInterval: ({ state }) =>
      getEmailExtractionRefetchInterval({
        extractionFileFieldId: state.data?.extractionFileFieldId,
        isEmailViewerActive: queryInput.isEmailViewerActive,
      }),
  });
  const entityState = useMemo(
    () =>
      getFileTabEntityState({
        entityData: query.data,
        entityQueryError: query.isError,
        needsPropertyResolution: queryInput.needsPropertyResolution,
        tab,
      }),
    [query.data, query.isError, queryInput.needsPropertyResolution, tab],
  );
  const downloadRenditions = useMemo(
    () =>
      getEntityFileDownloadRenditions({
        entityData: query.data,
        fieldId: tab.id,
      }),
    [query.data, tab.id],
  );
  const queryState = useMemo(
    () => ({
      data: query.data,
      isError: query.isError,
      refetch: query.refetch,
    }),
    [query.data, query.isError, query.refetch],
  );

  return useMemo(
    () => ({
      ...entityState,
      downloadRenditions,
      query: queryState,
    }),
    [downloadRenditions, entityState, queryState],
  );
};

export type FileTabEntity = ReturnType<typeof useFileTabEntity>;
