import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { ratesQueryRoot } from "@/lib/resource-query-roots.logic";
import { toSafeId } from "@/lib/safe-id";

const ratesKeys = {
  all: ratesQueryRoot,
  tables: (workspaceId: string) => [...ratesKeys.all(workspaceId), "tables"],
  entries: (workspaceId: string, rateTableId: string) => [
    ...ratesKeys.all(workspaceId),
    "entries",
    rateTableId,
  ],
  resolve: ({
    workspaceId,
    userId,
    date,
    activityCode,
  }: ResolvedRateOptions) => [
    ...ratesKeys.all(workspaceId),
    "resolve",
    userId,
    date,
    activityCode,
  ],
};

export const rateTablesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ratesKeys.tables(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .get({ fetch: { signal } });

      return unwrapApiResponse(response).items;
    },
  });

export const rateEntriesOptions = (workspaceId: string, rateTableId: string) =>
  queryOptions({
    queryKey: ratesKeys.entries(workspaceId, rateTableId),
    queryFn: async ({ signal }) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          rateTableId: toSafeId<"rateTable">(rateTableId),
        })
        .entries.get({ fetch: { signal } });

      return unwrapApiResponse(response).items;
    },
    enabled: rateTableId.length > 0,
  });

type ResolvedRateOptions = {
  workspaceId: string;
  userId: string;
  date: string;
  activityCode: string;
};

export const resolvedRateOptions = ({
  workspaceId,
  userId,
  date,
  activityCode,
}: ResolvedRateOptions) =>
  queryOptions({
    queryKey: ratesKeys.resolve({ workspaceId, userId, date, activityCode }),
    queryFn: async ({ signal }) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .resolve.get({
          query: {
            userId: toSafeId<"user">(userId),
            date,
            ...(activityCode && { activityCode }),
          },
          fetch: { signal },
        });

      return unwrapApiResponse(response);
    },
    enabled: userId.length > 0 && date.length > 0,
  });
