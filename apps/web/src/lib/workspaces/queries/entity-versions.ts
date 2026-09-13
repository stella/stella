import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

import { entitiesKeys } from "./entities";

type EntityVersionsKey = {
  workspaceId: string;
  entityId: string;
  filePropertyId?: string | undefined;
};

export type EntityVersion = {
  id: string;
  versionNumber: number;
  stamp: string | null;
  label: string | null;
  description: string | null;
  diffWordsAdded: number | null;
  diffWordsRemoved: number | null;
  createdAt: string;
  author: { id: string; name: string; image: string | null } | null;
  file: {
    fieldId: string;
    propertyId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  } | null;
};

type EntityVersionsData = {
  versions: EntityVersion[];
  olderCursor: string | null;
  currentVersionId: string | null;
};

export const entityVersionsKeys = {
  all: ({ workspaceId, entityId, filePropertyId }: EntityVersionsKey) =>
    filePropertyId === undefined
      ? entitiesKeys.versions(workspaceId, entityId)
      : [...entitiesKeys.versions(workspaceId, entityId), { filePropertyId }],
};

export const entityVersionsOptions = ({
  workspaceId,
  entityId,
  filePropertyId,
}: EntityVersionsKey) =>
  ({
    queryKey: entityVersionsKeys.all({ workspaceId, entityId, filePropertyId }),
    retry: shouldRetryAPIRequest,
    queryFn: async ({
      signal,
    }: {
      signal: AbortSignal;
    }): Promise<EntityVersionsData> => {
      const response = await api
        .entities({ workspaceId })
        .entity({ entityId })
        .versions.get({
          ...(filePropertyId === undefined
            ? {}
            : {
                query: {
                  filePropertyId: toSafeId<"property">(filePropertyId),
                },
              }),
          fetch: { signal },
        });

      const data = unwrapEden(response);
      return {
        versions: data.versions,
        olderCursor: data.olderCursor,
        currentVersionId: data.currentVersionId,
      };
    },
  }) as const;

export const fetchOlderVersions = async ({
  workspaceId,
  entityId,
  before,
  filePropertyId,
}: EntityVersionsKey & { before: string }): Promise<EntityVersionsData> => {
  const response = await api
    .entities({ workspaceId })
    .entity({ entityId })
    .versions.get({
      query:
        filePropertyId === undefined
          ? { before }
          : { before, filePropertyId: toSafeId<"property">(filePropertyId) },
    });

  const data = unwrapEden(response);

  return {
    versions: data.versions,
    olderCursor: data.olderCursor,
    currentVersionId: data.currentVersionId,
  };
};

// Resolve a single field's file metadata, for the document viewer to render a
// version whose field is outside the paginated newest page (switch to an old
// version, then reload). Kept off the versions cache key so it never refetches
// the page; fired only when the active field isn't already loaded.
type FieldFileData = {
  file: {
    propertyId: string;
    fileName: string;
    mimeType: string;
  } | null;
};

export const fieldFileOptions = ({
  workspaceId,
  entityId,
  fieldId,
  enabled = true,
}: EntityVersionsKey & { fieldId: string; enabled?: boolean }) =>
  ({
    queryKey: [
      ...entityVersionsKeys.all({ workspaceId, entityId }),
      "field-file",
      fieldId,
    ],
    enabled,
    retry: shouldRetryAPIRequest,
    queryFn: async ({
      signal,
    }: {
      signal: AbortSignal;
    }): Promise<FieldFileData> => {
      const response = await api
        .entities({ workspaceId })
        .entity({ entityId })
        .field({ fieldId })
        .file.get({ fetch: { signal } });

      const { file } = unwrapEden(response);
      if (file === null) {
        return { file: null };
      }

      return {
        file: {
          propertyId: file.propertyId,
          fileName: file.fileName,
          mimeType: file.mimeType,
        },
      };
    },
  }) as const;
