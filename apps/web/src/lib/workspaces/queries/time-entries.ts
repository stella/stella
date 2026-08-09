import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { timeEntriesQueryRoot } from "@/lib/resource-query-roots.logic";
import { toSafeId } from "@/lib/safe-id";

type TimeEntryStatus = "draft" | "approved" | "billed" | "written_off";

type TimeEntrySource = "manual" | "timer";

type TimeEntriesFilters = {
  userId?: string;
  scope?: "me";
  workItemId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: TimeEntryStatus;
  source?: TimeEntrySource;
  billable?: boolean;
  hasActiveTimer?: boolean;
};

type TimeEntriesListKey = {
  userId?: string | undefined;
  scope?: "me" | undefined;
  workItemId?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  status?: TimeEntryStatus | undefined;
  source?: TimeEntrySource | undefined;
  billable?: boolean | undefined;
  hasActiveTimer?: boolean | undefined;
};

export const timeEntriesKeys = {
  all: timeEntriesQueryRoot,
  list: (workspaceId: string, key: TimeEntriesListKey) => [
    ...timeEntriesKeys.all(workspaceId),
    {
      userId: key.userId,
      scope: key.scope,
      workItemId: key.workItemId,
      dateFrom: key.dateFrom,
      dateTo: key.dateTo,
      status: key.status,
      source: key.source,
      billable: key.billable,
      hasActiveTimer: key.hasActiveTimer,
    },
  ],
  byId: (workspaceId: string, id: string) => [
    ...timeEntriesKeys.all(workspaceId),
    id,
  ],
  activeTimer: (workspaceId: string) => [
    ...timeEntriesKeys.all(workspaceId),
    "timer",
  ],
  summary: (workspaceId: string, dateFrom: string, dateTo: string) => [
    ...timeEntriesKeys.all(workspaceId),
    "summary",
    { dateFrom, dateTo },
  ],
  teamSummary: (workspaceId: string, dateFrom: string, dateTo: string) => [
    ...timeEntriesKeys.all(workspaceId),
    "teamSummary",
    { dateFrom, dateTo },
  ],
};

const listTimeEntries = async ({
  workspaceId,
  filters,
  cursor,
  signal,
}: {
  workspaceId: string;
  filters: TimeEntriesFilters;
  cursor?: string;
  signal?: AbortSignal;
}) => {
  const { workItemId, userId, ...restFilters } = filters;
  const response = await api["time-entries"]({
    workspaceId: toSafeId<"workspace">(workspaceId),
  }).get({
    query: {
      ...restFilters,
      ...(cursor !== undefined && { cursor }),
      ...(userId !== undefined && { userId: toSafeId<"user">(userId) }),
      ...(workItemId !== undefined && {
        workItemId: toSafeId<"entity">(workItemId),
      }),
    },
    fetch: signal ? { signal } : {},
  });

  return unwrapEden(response);
};

export const timeEntriesOptions = (
  workspaceId: string,
  filters: TimeEntriesFilters = {},
) =>
  queryOptions({
    queryKey: timeEntriesKeys.list(workspaceId, filters),
    queryFn: async ({ signal }) =>
      (await listTimeEntries({ workspaceId, filters, signal })).items,
  });

export const timeEntriesInfiniteOptions = (
  workspaceId: string,
  filters: TimeEntriesFilters = {},
) =>
  infiniteQueryOptions({
    queryKey: [...timeEntriesKeys.list(workspaceId, filters), "infinite"],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) =>
      await listTimeEntries({
        workspaceId,
        filters,
        ...(pageParam.length > 0 && { cursor: pageParam }),
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const timeEntrySummaryOptions = (
  workspaceId: string,
  dateFrom: string,
  dateTo: string,
) =>
  queryOptions({
    queryKey: timeEntriesKeys.summary(workspaceId, dateFrom, dateTo),
    queryFn: async ({ signal }) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).summary.get({
        query: { dateFrom, dateTo },
        fetch: { signal },
      });
      return unwrapEden(response);
    },
  });

export const timeEntryTeamSummaryOptions = (
  workspaceId: string,
  dateFrom: string,
  dateTo: string,
) =>
  queryOptions({
    queryKey: timeEntriesKeys.teamSummary(workspaceId, dateFrom, dateTo),
    queryFn: async ({ signal }) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      })["team-summary"].get({
        query: { dateFrom, dateTo },
        fetch: { signal },
      });
      return unwrapEden(response);
    },
  });

export const activeTimerOptions = (workspaceId: string) =>
  queryOptions({
    staleTime: 0,
    queryKey: timeEntriesKeys.activeTimer(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).get({
        query: {
          source: "timer",
          status: "draft",
          hasActiveTimer: true,
        },
        fetch: { signal },
      });

      return unwrapEden(response).items.at(0) ?? null;
    },
    refetchInterval: 60_000,
  });
