import { queryOptions } from "@tanstack/react-query";

import { useI18nStore } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceView } from "@/lib/types";

export const viewsKeys = {
  // Default view names are localized server-side per Accept-Language, so the
  // cache identity must include the locale — otherwise switching language keeps
  // serving the previously-localized names until an unrelated refetch. Use
  // `loadedLang` (not `lang`): the request's Accept-Language comes from
  // getFormattingLocale(), which reads loadedLang, so the key must match the
  // locale actually used for the response. Read here rather than threaded
  // through callers so the query and the mutations' cache ops stay on one key.
  all: (workspaceId: string) => [
    "views",
    workspaceId,
    useI18nStore.getState().loadedLang,
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
