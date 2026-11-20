import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapApiResponse } from "@/lib/errors/api";

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
  ({
    queryKey: similarDocumentsKey(workspaceId, entityId),
    retry: shouldRetryAPIRequest,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const response = await api
        .entities({ workspaceId })
        .entity({ entityId })
        .similar.get({ fetch: { signal } });
      return unwrapApiResponse(response).documents;
    },
  }) as const;
