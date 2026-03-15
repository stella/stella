import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { stripUndefined } from "@/lib/utils";

type DateRange = {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
};

type PeriodParams = DateRange & {
  granularity?: "day" | "week" | "month" | undefined;
};

const analyticsKeys = {
  all: (workspaceId: string) => ["analytics", workspaceId] as const,
  summary: (workspaceId: string, range: DateRange) =>
    [...analyticsKeys.all(workspaceId), "summary", range] as const,
  hoursByMatter: (workspaceId: string, range: DateRange) =>
    [...analyticsKeys.all(workspaceId), "hours-by-matter", range] as const,
  hoursByUser: (workspaceId: string, range: DateRange) =>
    [...analyticsKeys.all(workspaceId), "hours-by-user", range] as const,
  hoursByPeriod: (workspaceId: string, params: PeriodParams) =>
    [...analyticsKeys.all(workspaceId), "hours-by-period", params] as const,
  revenueByPeriod: (workspaceId: string, params: PeriodParams) =>
    [...analyticsKeys.all(workspaceId), "revenue-by-period", params] as const,
};

export const summaryOptions = (workspaceId: string, range: DateRange) =>
  queryOptions({
    queryKey: analyticsKeys.summary(workspaceId, range),
    queryFn: async ({ signal }) => {
      const response = await api.analytics({ workspaceId }).summary.get({
        query: stripUndefined(range),
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

export const hoursByMatterOptions = (workspaceId: string, range: DateRange) =>
  queryOptions({
    queryKey: analyticsKeys.hoursByMatter(workspaceId, range),
    queryFn: async ({ signal }) => {
      const response = await api
        .analytics({ workspaceId })
        ["hours-by-matter"].get({
          query: stripUndefined(range),
          fetch: { signal },
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

export const hoursByUserOptions = (workspaceId: string, range: DateRange) =>
  queryOptions({
    queryKey: analyticsKeys.hoursByUser(workspaceId, range),
    queryFn: async ({ signal }) => {
      const response = await api
        .analytics({ workspaceId })
        ["hours-by-user"].get({
          query: stripUndefined(range),
          fetch: { signal },
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

export const hoursByPeriodOptions = (
  workspaceId: string,
  params: PeriodParams,
) =>
  queryOptions({
    queryKey: analyticsKeys.hoursByPeriod(workspaceId, params),
    queryFn: async ({ signal }) => {
      const response = await api
        .analytics({ workspaceId })
        ["hours-by-period"].get({
          query: stripUndefined(params),
          fetch: { signal },
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

export const revenueByPeriodOptions = (
  workspaceId: string,
  params: PeriodParams,
) =>
  queryOptions({
    queryKey: analyticsKeys.revenueByPeriod(workspaceId, params),
    queryFn: async ({ signal }) => {
      const response = await api
        .analytics({ workspaceId })
        ["revenue-by-period"].get({
          query: stripUndefined(params),
          fetch: { signal },
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });
