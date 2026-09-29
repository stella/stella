import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import type { TimeEntrySource, TimeEntryStatus } from "@stll/api-contract";

import {
  fetchTimeEntries,
  fetchTimeEntrySuggestions,
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
  narrativeLanguage: string | null;
  source: TimeEntrySource;
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

const timeEntriesListKey = (key: TimeEntriesListKey) => ({
  userId: key.userId,
  scope: key.scope,
  workItemId: key.workItemId,
  dateFrom: key.dateFrom,
  dateTo: key.dateTo,
  status: key.status,
  source: key.source,
  billable: key.billable,
  hasActiveTimer: key.hasActiveTimer,
});

export const timeEntriesKeys = {
  all: (workspaceId: string) => ["timeEntries", workspaceId],
  list: (workspaceId: string, key: TimeEntriesListKey) => [
    ...timeEntriesKeys.all(workspaceId),
    timeEntriesListKey(key),
  ],
  // The signed-in user's entries (`scope: "me"`).
  personalList: (
    workspaceId: string,
    userId: string,
    key: TimeEntriesListKey & { scope: "me" },
  ) => [...timeEntriesKeys.all(workspaceId), userId, timeEntriesListKey(key)],
  byId: (workspaceId: string, id: string) => [
    ...timeEntriesKeys.all(workspaceId),
    id,
  ],
  activeTimer: (workspaceId: string, userId: string) => [
    ...timeEntriesKeys.all(workspaceId),
    userId,
    "timer",
  ],
  summary: (
    workspaceId: string,
    userId: string,
    dateFrom: string,
    dateTo: string,
  ) => [
    ...timeEntriesKeys.all(workspaceId),
    userId,
    "summary",
    { dateFrom, dateTo },
  ],
  teamSummary: (
    workspaceId: string,
    userId: string,
    dateFrom: string,
    dateTo: string,
  ) => [
    ...timeEntriesKeys.all(workspaceId),
    userId,
    "teamSummary",
    { dateFrom, dateTo },
  ],
  suggestions: (
    workspaceId: string,
    userId: string,
    date: string,
    timezoneId: string,
  ) => [
    ...timeEntriesKeys.all(workspaceId),
    userId,
    "suggestions",
    { date, timezoneId },
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
        narrativeLanguage,
        source,
        status,
        timerStartedAt,
      }) => ({
        billable,
        dateWorked,
        durationMinutes,
        id,
        narrative,
        narrativeLanguage,
        source,
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
  userId: string,
  filters: TimeEntriesFilters & { scope: "me" },
) =>
  infiniteQueryOptions({
    queryKey: [
      ...timeEntriesKeys.personalList(workspaceId, userId, filters),
      "infinite",
    ],
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
  userId: string,
  dateFrom: string,
  dateTo: string,
) =>
  queryOptions({
    queryKey: timeEntriesKeys.summary(workspaceId, userId, dateFrom, dateTo),
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
  userId: string,
  dateFrom: string,
  dateTo: string,
) =>
  queryOptions({
    queryKey: timeEntriesKeys.teamSummary(
      workspaceId,
      userId,
      dateFrom,
      dateTo,
    ),
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
          ({ daily, email, image, name, userId: memberUserId }) => ({
            daily: daily.map(({ dateWorked, totalMinutes }) => ({
              dateWorked,
              totalMinutes,
            })),
            email,
            image,
            name,
            userId: memberUserId,
          }),
        ),
      } satisfies TeamTimeEntrySummary;
    },
  });

export const timeEntrySuggestionsOptions = (
  workspaceId: string,
  userId: string,
  date: string,
  timezoneId: string,
) =>
  queryOptions({
    queryKey: timeEntriesKeys.suggestions(
      workspaceId,
      userId,
      date,
      timezoneId,
    ),
    queryFn: async ({ signal }) =>
      await fetchTimeEntrySuggestions({
        workspaceId,
        query: { date, timezoneId },
        signal,
      }),
  });

export const activeTimerOptions = (workspaceId: string, userId: string) =>
  queryOptions({
    staleTime: 0,
    queryKey: timeEntriesKeys.activeTimer(workspaceId, userId),
    queryFn: async ({ signal }) => {
      const page = await fetchTimeEntries({
        workspaceId,
        query: {
          scope: "me",
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
