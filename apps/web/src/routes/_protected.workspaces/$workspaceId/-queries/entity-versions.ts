import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";

import { entitiesKeys } from "./entities";

type EntityVersionsKey = {
  workspaceId: string;
  entityId: string;
};

export const entityVersionsKeys = {
  all: ({ workspaceId, entityId }: EntityVersionsKey) => [
    ...entitiesKeys.all(workspaceId),
    entityId,
    "versions",
  ],
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
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId })
        .entity({ entityId })
        .versions.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
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

  if (response.error) {
    throw toAPIError(response.error);
  }

  return {
    versions: response.data.versions,
    olderCursor: response.data.olderCursor,
  };
};

// Resolve a single field's file metadata, for the document viewer to render a
// version whose field is outside the paginated newest page (switch to an old
// version, then reload). Kept off the versions cache key so it never refetches
// the page; fired only when the active field isn't already loaded.
export const fieldFileOptions = ({
  workspaceId,
  entityId,
  fieldId,
}: EntityVersionsKey & { fieldId: string }) =>
  queryOptions({
    queryKey: [
      ...entityVersionsKeys.all({ workspaceId, entityId }),
      "field-file",
      fieldId,
    ],
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId })
        .entity({ entityId })
        .field({ fieldId })
        .file.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export const entityVersionDetailOptions = ({
  workspaceId,
  entityId,
  versionId,
}: EntityVersionsKey & { versionId: string }) =>
  queryOptions({
    queryKey: entityVersionsKeys.detail({ workspaceId, entityId, versionId }),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId })
        .entity({ entityId })
        .versions({ versionId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
