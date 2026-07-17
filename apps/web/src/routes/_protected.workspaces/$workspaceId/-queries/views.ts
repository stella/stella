import { queryOptions } from "@tanstack/react-query";

import { useI18nStore } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceView } from "@/lib/types";

export const viewsKeys = {
  // Locale-independent prefix. Mutations invalidate this so every cached locale
  // variant (`["views", workspaceId, lang]`) is dropped, not just the one
  // currently loaded — React Query matches `invalidateQueries` by prefix.
  all: (workspaceId: string) => ["views", workspaceId],
  // Default view names are localized server-side per Accept-Language, so the
  // cache identity must include the locale — otherwise switching language keeps
  // serving the previously-localized names until an unrelated refetch. Use
  // `loadedLang` (not `lang`): the request's Accept-Language comes from
  // getFormattingLocale(), which reads loadedLang, so the key must match the
  // locale actually used for the response. Read here rather than threaded
  // through callers so the query stays on one key.
  localized: (workspaceId: string) => [
    ...viewsKeys.all(workspaceId),
    useI18nStore.getState().loadedLang,
  ],
};

export const viewsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: viewsKeys.localized(workspaceId),
    queryFn: async ({ signal }): Promise<WorkspaceView[]> => {
      const response = await api
        .views({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .get({ fetch: { signal } });

      return unwrapEden(response);
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
