import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";

import { entitiesKeys } from "./entities";

type EntityVersionsKey = {
  workspaceId: string;
  entityId: string;
};

export const entityVersionsKeys = {
  all: ({ workspaceId, entityId }: EntityVersionsKey) =>
    entitiesKeys.versions(workspaceId, entityId),
  detail: ({
    workspaceId,
    entityId,
    versionId,
  }: EntityVersionsKey & { versionId: string }) => [
    ...entityVersionsKeys.all({ workspaceId, entityId }),
    versionId,
  ],
};

export const entityVersionsOptions = ({
  workspaceId,
  entityId,
}: EntityVersionsKey) =>
  queryOptions({
    queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
    retry: shouldRetryAPIRequest,
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId })
        .entity({ entityId })
        .versions.get({ fetch: { signal } });

      return unwrapEden(response);
    },
  });

export const fetchOlderVersions = async ({
  workspaceId,
  entityId,
  before,
}: EntityVersionsKey & { before: string }) => {
  const response = await api
    .entities({ workspaceId })
    .entity({ entityId })
    .versions.get({ query: { before } });

  const data = unwrapEden(response);

  return {
    versions: data.versions,
    olderCursor: data.olderCursor,
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
  queryOptions({
    queryKey: [
      ...entityVersionsKeys.all({ workspaceId, entityId }),
      "field-file",
      fieldId,
    ],
    enabled,
    retry: shouldRetryAPIRequest,
    queryFn: async ({ signal }): Promise<FieldFileData> => {
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
  });

export const entityVersionDetailOptions = ({
  workspaceId,
  entityId,
  versionId,
}: EntityVersionsKey & { versionId: string }) =>
  queryOptions({
    queryKey: entityVersionsKeys.detail({ workspaceId, entityId, versionId }),
    retry: shouldRetryAPIRequest,
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId })
        .entity({ entityId })
        .versions({ versionId })
        .get({ fetch: { signal } });

      return unwrapEden(response);
    },
  });
