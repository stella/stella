import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

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
