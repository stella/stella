import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

type TimeEntryStatus = "draft" | "approved" | "billed" | "written_off";

type TimeEntrySource = "manual" | "timer";

type TimeEntriesFilters = {
  userId?: string;
  matterId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: TimeEntryStatus;
  source?: TimeEntrySource;
  billable?: boolean;
  hasActiveTimer?: boolean;
};

export const timeEntriesKeys = {
  all: (workspaceId: string) => ["timeEntries", workspaceId],
  list: (workspaceId: string, filters: TimeEntriesFilters) => [
    ...timeEntriesKeys.all(workspaceId),
    filters,
  ],
  byId: (workspaceId: string, id: string) => [
    ...timeEntriesKeys.all(workspaceId),
    id,
  ],
  activeTimer: (workspaceId: string) => [
    ...timeEntriesKeys.all(workspaceId),
    "timer",
  ],
};

export const timeEntriesOptions = (
  workspaceId: string,
  filters: TimeEntriesFilters = {},
) =>
  queryOptions({
    queryKey: timeEntriesKeys.list(workspaceId, filters),
    queryFn: async ({ signal }) => {
      const { matterId, userId, ...restFilters } = filters;
      const response = await api["time-entries"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      }).get({
        query: {
          ...restFilters,
          ...(userId !== undefined && { userId: toSafeId<"user">(userId) }),
          ...(matterId !== undefined && {
            matterId: toSafeId<"entity">(matterId),
          }),
        },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
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

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data?.at(0) ?? null;
    },
    refetchInterval: 60_000,
  });
