import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { ViewFilterCondition } from "@/lib/types";
import { normalizeVisibleFieldIds } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";
import type { ViewSort } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";

type CalendarTasksKey = {
  workspaceId: string;
  dateFrom: string;
  dateTo: string;
  datePropertyIds: string[];
  endDatePropertyId?: string | undefined;
  filters: ViewFilterCondition[];
  sorts: ViewSort[];
};

export const calendarTasksKeys = {
  all: (workspaceId: string) => ["calendar-tasks", workspaceId],
  range: ({
    dateFrom,
    datePropertyIds,
    dateTo,
    endDatePropertyId,
    filters,
    sorts,
    workspaceId,
  }: CalendarTasksKey) => [
    ...calendarTasksKeys.all(workspaceId),
    {
      dateFrom,
      dateTo,
      datePropertyIds: normalizeVisibleFieldIds(datePropertyIds),
      endDatePropertyId,
      filters,
      sorts,
    },
  ],
};

const fetchCalendarTasks = async ({
  signal,
  ...key
}: CalendarTasksKey & { signal?: AbortSignal }) => {
  const response = await api
    .tasks({ workspaceId: key.workspaceId })
    .calendar.post(
      {
        dateFrom: key.dateFrom,
        dateTo: key.dateTo,
        datePropertyIds: normalizeVisibleFieldIds(key.datePropertyIds),
        ...(key.endDatePropertyId && {
          endDatePropertyId: key.endDatePropertyId,
        }),
        filters: key.filters,
        sorts: key.sorts,
      },
      { fetch: { signal: signal ?? null } },
    );

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data.tasks;
};

export type CalendarTask = Awaited<
  ReturnType<typeof fetchCalendarTasks>
>[number];

export const calendarTasksOptions = (key: CalendarTasksKey) =>
  queryOptions({
    queryKey: calendarTasksKeys.range(key),
    queryFn: async ({ signal }) => await fetchCalendarTasks({ ...key, signal }),
  });
