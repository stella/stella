import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import type { TimeEntrySource, TimeEntryStatus } from "@stll/api-contract";

import {
  fetchTimeEntries,
  fetchTimeEntrySummary,
} from "@/lib/workspaces/time-entries-api";

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

type PersonalTimeEntry = {
  billable: boolean;
  dateWorked: string;
  durationMinutes: number;
  id: string;
  narrative: string;
  status: TimeEntryStatus;
  timerStartedAt: string | null;
};

type PersonalTimeEntryPage = {
  items: PersonalTimeEntry[];
  nextCursor: string | null;
};

type PersonalTimeEntrySummary = {
  billedMinutes: number;
  entryCount: number;
  totalMinutes: number;
};

type TeamTimeEntrySummary = {
  members: {
    daily: { dateWorked: string; totalMinutes: number }[];
    email: string;
    image: string | null;
    name: string;
    userId: string;
  }[];
  totalTeamMinutes: number;
  viewerTotalMinutes: number;
};

export const timeEntriesKeys = {
  all: (workspaceId: string) => ["timeEntries", workspaceId],
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
}) =>
  fetchTimeEntries({
    workspaceId,
    query: {
      ...filters,
      ...(cursor !== undefined && { cursor }),
    },
    signal,
  });

type ListPersonalTimeEntriesOptions = {
  cursor: string | undefined;
  filters: TimeEntriesFilters;
  signal: AbortSignal | undefined;
  workspaceId: string;
};

const listPersonalTimeEntries = async ({
  cursor,
  filters,
  signal,
  workspaceId,
}: ListPersonalTimeEntriesOptions): Promise<PersonalTimeEntryPage> => {
  const page = await listTimeEntries({
    workspaceId,
    filters,
    ...(cursor !== undefined && { cursor }),
    ...(signal !== undefined && { signal }),
  });
  return {
    items: page.items.map(
      ({
        billable,
        dateWorked,
        durationMinutes,
        id,
        narrative,
        status,
        timerStartedAt,
      }) => ({
        billable,
        dateWorked,
        durationMinutes,
        id,
        narrative,
        status,
        timerStartedAt,
      }),
    ),
    nextCursor: page.nextCursor,
  };
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
      await listPersonalTimeEntries({
        workspaceId,
        filters,
        cursor: pageParam.length > 0 ? pageParam : undefined,
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
      const summary = await fetchTimeEntrySummary({
        workspaceId,
        query: { dateFrom, dateTo },
        signal,
      });
      if (summary.scope !== "personal") {
        return panic("Expected a personal time-entry summary");
      }
      return {
        entryCount: summary.entryCount,
        totalMinutes: summary.totalMinutes,
        billedMinutes: summary.billedMinutes,
      } satisfies PersonalTimeEntrySummary;
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
      const summary = await fetchTimeEntrySummary({
        workspaceId,
        query: { dateFrom, dateTo, scope: "team" },
        signal,
      });
      if (summary.scope !== "team") {
        return panic("Expected a team time-entry summary");
      }
      return {
        viewerTotalMinutes: summary.viewerTotalMinutes,
        totalTeamMinutes: summary.totalTeamMinutes,
        members: summary.members.map(
          ({ daily, email, image, name, userId }) => ({
            daily: daily.map(({ dateWorked, totalMinutes }) => ({
              dateWorked,
              totalMinutes,
            })),
            email,
            image,
            name,
            userId,
          }),
        ),
      } satisfies TeamTimeEntrySummary;
    },
  });

export const activeTimerOptions = (workspaceId: string) =>
  queryOptions({
    staleTime: 0,
    queryKey: timeEntriesKeys.activeTimer(workspaceId),
    queryFn: async ({ signal }) => {
      const page = await fetchTimeEntries({
        workspaceId,
        query: {
          source: "timer",
          status: "draft",
          hasActiveTimer: true,
        },
        signal,
      });

      return page.items.at(0) ?? null;
    },
    refetchInterval: 60_000,
  });
