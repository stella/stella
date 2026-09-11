import { queryOptions } from "@tanstack/react-query";

import { useI18nStore } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceView } from "@/lib/types";
import { viewsRootKey } from "@/lib/workspaces/queries/views.logic";
import { useTableStore } from "@/lib/workspaces/table-store";

export const viewsKeys = {
  // Locale-independent prefix. Mutations invalidate this so every cached locale
  // variant (`["views", workspaceId, lang]`) is dropped, not just the one
  // currently loaded — React Query matches `invalidateQueries` by prefix.
  all: viewsRootKey,
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
      const views = unwrapEden(response);

      // The one owner of per-view table state cleanup: every path that
      // removes a view (this client, another, the CLI, MCP, or a delete
      // while this browser was closed) ends in a fetch of this list, so
      // reconciling here needs no component or mutation to remember to.
      // The list is complete (`handlers/views/list.ts` is unfiltered and
      // capped at the creation limit), so absence means deleted. Writing to
      // a localStorage-backed store inside a query function is safe because
      // protected routes are `ssr: false`: the loader prefetch never runs on
      // the server. It runs after `unwrapEden`, so a failed fetch drops
      // nothing.
      useTableStore.getState().reconcileViews(
        workspaceId,
        views.map((view) => view.id),
      );

      return views;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
