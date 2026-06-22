import { queryOptions } from "@tanstack/react-query";

import { useI18nStore } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceView } from "@/lib/types";

export const viewsKeys = {
  // Default view names are localized server-side per Accept-Language, so the
  // cache identity must include the UI language — otherwise switching language
  // keeps serving the previously-localized names until an unrelated refetch.
  // Read here rather than threaded through callers so the query and the
  // mutations' cache ops (setQueryData/invalidate) stay on the same key.
  all: (workspaceId: string) => [
    "views",
    workspaceId,
    useI18nStore.getState().lang,
  ],
};

export const viewsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: viewsKeys.all(workspaceId),
    queryFn: async ({ signal }): Promise<WorkspaceView[]> => {
      const response = await api
        .views({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
