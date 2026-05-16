import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

export const ratesKeys = {
  all: (workspaceId: string) => ["rates", workspaceId],
  tables: (workspaceId: string) => [...ratesKeys.all(workspaceId), "tables"],
  entries: (workspaceId: string, rateTableId: string) => [
    ...ratesKeys.all(workspaceId),
    "entries",
    rateTableId,
  ],
  resolve: (workspaceId: string, userId: string, date: string) => [
    ...ratesKeys.all(workspaceId),
    "resolve",
    userId,
    date,
  ],
};

export const rateTablesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ratesKeys.tables(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.items;
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

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.items;
    },
    enabled: rateTableId.length > 0,
  });

export const resolvedRateOptions = (
  workspaceId: string,
  userId: string,
  date: string,
) =>
  queryOptions({
    queryKey: ratesKeys.resolve(workspaceId, userId, date),
    queryFn: async ({ signal }) => {
      const response = await api
        .rates({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .resolve.get({
          query: { userId: toSafeId<"user">(userId), date },
          fetch: { signal },
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    enabled: userId.length > 0 && date.length > 0,
  });
