import { queryOptions } from "@tanstack/react-query";

import {
  TIME_ENTRY_REPORT_TOO_LARGE_CODE,
  type TimeEntryReport,
  type TimeEntryReportBucket,
  type TimeEntryReportGroupBy,
} from "@stll/api-contract/time-entry-report";

import { api } from "@/lib/api";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";

import type { ReportRange } from "./report.logic";

export type ReportFilter = ReportRange & {
  groupBy: TimeEntryReportGroupBy;
  bucket: TimeEntryReportBucket;
};
/**
 * A report the API read, or its refusal of a range whose rows exceed the
 * bound. The refusal depends on the data, so the page explains it in place
 * instead of failing the route.
 */
export type TimeReportResult =
  { type: "report"; report: TimeEntryReport } | { type: "too-large" };

export const timeReportOptions = (
  organizationId: string,
  userId: string,
  filter: ReportFilter,
) =>
  queryOptions({
    queryKey: ["timeReport", organizationId, userId, filter],
    queryFn: async ({ signal }): Promise<TimeReportResult> => {
      const response = await api["time-entries"].report.get({
        query: filter,
        fetch: { signal },
      });
      if (
        response.error !== null &&
        toAPIError(response.error).code === TIME_ENTRY_REPORT_TOO_LARGE_CODE
      ) {
        return { type: "too-large" };
      }
      return { type: "report", report: unwrapApiResponse(response) };
    },
  });
