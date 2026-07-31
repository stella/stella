import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

export const REPORT_EXPORTS_PAGE_SIZE = 20;
const REPORT_EXPORT_HISTORY_POLL_INTERVAL_MS = 2000;

type ReportExportsHistoryKey = {
  limit: number;
  workspaceId: string;
};

type ReportExportDetailKey = {
  exportId: string;
  workspaceId: string;
};

export const reportExportsKeys = {
  all: (workspaceId: string) => ["report-exports", workspaceId],
  history: (key: ReportExportsHistoryKey) => [
    ...reportExportsKeys.all(key.workspaceId),
    "history",
    { limit: key.limit },
  ],
  detail: (key: ReportExportDetailKey) => [
    ...reportExportsKeys.all(key.workspaceId),
    "detail",
    key.exportId,
  ],
};

type ReportExportsHistoryOptionsInput =
  QueryOptionsInput<ReportExportsHistoryKey>;
type ReportExportDetailOptionsInput = QueryOptionsInput<ReportExportDetailKey>;

export const reportExportsHistoryOptions = (
  key: ReportExportsHistoryOptionsInput,
) =>
  infiniteQueryOptions({
    queryKey: reportExportsKeys.history(key),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api
        .workspaces({
          workspaceId: toSafeId<"workspace">(key.workspaceId),
        })
        .reports.get({
          query: {
            limit: key.limit,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
          fetch: { signal },
        });

      return unwrapEden(response);
    },
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages;
      if (pages === undefined) {
        return false;
      }
      const hasNonTerminalExport = pages.some((page) =>
        page.items.some(
          ({ status }) => status === "queued" || status === "running",
        ),
      );
      return hasNonTerminalExport
        ? REPORT_EXPORT_HISTORY_POLL_INTERVAL_MS
        : false;
    },
  });

export const reportExportDetailOptions = (
  key: ReportExportDetailOptionsInput,
) =>
  queryOptions({
    queryKey: reportExportsKeys.detail(key),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({
          workspaceId: toSafeId<"workspace">(key.workspaceId),
        })
        .reports({
          exportId: toSafeId<"reportExport">(key.exportId),
        })
        .get({ fetch: { signal } });

      return unwrapEden(response);
    },
    staleTime: 0,
  });
