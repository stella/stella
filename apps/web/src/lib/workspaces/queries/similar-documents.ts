import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapApiResponse } from "@/lib/errors/api";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

import { entityDetailKey } from "./entity-keys.logic";

/** Under the entity's own key, so a new version refreshes it too. */
export const similarDocumentsKey = (workspaceId: string, entityId: string) => [
  ...entityDetailKey(workspaceId, entityId),
  "similar",
];

export const similarDocumentsOptions = (
  workspaceId: string,
  entityId: string,
) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: similarDocumentsKey(workspaceId, entityId),
      retry: shouldRetryAPIRequest,
      queryFn: async ({ signal }) => {
        const response = await api
          .entities({ workspaceId })
          .entity({ entityId })
          .similar.get({ fetch: { signal } });
        return unwrapApiResponse(response).documents;
      },
    }),
    {
      resources: [RESOURCE_TYPE.ENTITY],
      scope: { type: "workspace", workspaceId },
    },
  );
