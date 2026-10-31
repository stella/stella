import { queryOptions } from "@tanstack/react-query";

import type {
  TimeEntryReportBucket,
  TimeEntryReportGroupBy,
} from "@stll/api-contract/time-entry-report";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";

import type { ReportRange } from "./report.logic";

export type ReportFilter = ReportRange & {
  groupBy: TimeEntryReportGroupBy;
  bucket: TimeEntryReportBucket;
};
export const timeReportOptions = (
  organizationId: string,
  userId: string,
  filter: ReportFilter,
) =>
  queryOptions({
    queryKey: ["timeReport", organizationId, userId, filter],
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api["time-entries"].report.get({
          query: filter,
          fetch: { signal },
        }),
      ),
  });
