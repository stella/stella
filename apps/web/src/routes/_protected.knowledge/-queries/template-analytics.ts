import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

type DateRange = {
  dateFrom?: string;
  dateTo?: string;
};

type PeriodParams = DateRange & {
  granularity?: "day" | "week" | "month";
};

const templateAnalyticsKeys = {
  all: () => ["template-analytics"] as const,
  summary: (range: DateRange) =>
    [...templateAnalyticsKeys.all(), "summary", range] as const,
  fillsByPeriod: (params: PeriodParams) =>
    [...templateAnalyticsKeys.all(), "fills-by-period", params] as const,
  topTemplates: (range: DateRange) =>
    [...templateAnalyticsKeys.all(), "top-templates", range] as const,
  fillsByUser: (range: DateRange) =>
    [...templateAnalyticsKeys.all(), "fills-by-user", range] as const,
};

export const templateSummaryOptions = (range: DateRange) =>
  queryOptions({
    queryKey: templateAnalyticsKeys.summary(range),
    queryFn: async ({ signal }) => {
      const response = await api["template-analytics"].summary.get({
        query: range,
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

export const fillsByPeriodOptions = (params: PeriodParams) =>
  queryOptions({
    queryKey: templateAnalyticsKeys.fillsByPeriod(params),
    queryFn: async ({ signal }) => {
      const response = await api["template-analytics"]["fills-by-period"].get({
        query: params,
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

export const topTemplatesOptions = (range: DateRange) =>
  queryOptions({
    queryKey: templateAnalyticsKeys.topTemplates(range),
    queryFn: async ({ signal }) => {
      const response = await api["template-analytics"]["top-templates"].get({
        query: range,
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

export const fillsByUserOptions = (range: DateRange) =>
  queryOptions({
    queryKey: templateAnalyticsKeys.fillsByUser(range),
    queryFn: async ({ signal }) => {
      const response = await api["template-analytics"]["fills-by-user"].get({
        query: range,
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });
