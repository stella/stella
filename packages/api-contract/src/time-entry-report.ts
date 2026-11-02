import * as v from "valibot";

import { apiDateSchema } from "./api-date";

export const TIME_ENTRY_REPORT_PERIODS = ["week", "month", "custom"] as const;

export const TIME_ENTRY_REPORT_GROUPS = ["member", "matter", "client"] as const;
export const TIME_ENTRY_REPORT_BUCKETS = ["day", "week", "month"] as const;

/** Row id of time recorded without a matter (internal work). */
export const TIME_ENTRY_REPORT_INTERNAL_ROW_ID = "internal";
/** Row id of matter time whose matter has no client, on the client grouping. */
export const TIME_ENTRY_REPORT_NO_CLIENT_ROW_ID = "no-client";
/**
 * Error code of a report the API refuses to read because its rows exceed the
 * bound; input validation answers with the same status, so clients tell the
 * two apart by this code.
 */
export const TIME_ENTRY_REPORT_TOO_LARGE_CODE = "time_report_too_large";

export const TIME_ENTRY_REPORT_QUERY_SCHEMA = v.object({
  from: apiDateSchema,
  to: apiDateSchema,
  groupBy: v.picklist(TIME_ENTRY_REPORT_GROUPS),
  bucket: v.picklist(TIME_ENTRY_REPORT_BUCKETS),
});

const nonnegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));

export const TIME_ENTRY_REPORT_METRICS_SCHEMA = v.object({
  recordedMinutes: nonnegativeInteger,
  billableMinutes: nonnegativeInteger,
  pendingEntries: nonnegativeInteger,
  activeMembers: nonnegativeInteger,
  unbilledValues: v.nullable(
    v.array(v.object({ currency: v.string(), value: v.number() })),
  ),
});

export const TIME_ENTRY_REPORT_ROW_SCHEMA = v.object({
  rowId: v.string(),
  rowName: v.nullable(v.string()),
  memberId: v.nullable(v.string()),
  matterId: v.nullable(v.string()),
  parentId: v.nullable(v.string()),
  bucket: apiDateSchema,
  minutes: nonnegativeInteger,
});

export const TIME_ENTRY_REPORT_SCHEMA = v.object({
  rows: v.array(TIME_ENTRY_REPORT_ROW_SCHEMA),
  summary: v.object({
    current: TIME_ENTRY_REPORT_METRICS_SCHEMA,
    previous: TIME_ENTRY_REPORT_METRICS_SCHEMA,
  }),
});

export type TimeEntryReportGroupBy = (typeof TIME_ENTRY_REPORT_GROUPS)[number];
export type TimeEntryReportBucket = (typeof TIME_ENTRY_REPORT_BUCKETS)[number];
export type TimeEntryReportQuery = v.InferOutput<
  typeof TIME_ENTRY_REPORT_QUERY_SCHEMA
>;
export type TimeEntryReportMetrics = v.InferOutput<
  typeof TIME_ENTRY_REPORT_METRICS_SCHEMA
>;
export type TimeEntryReportRow = v.InferOutput<
  typeof TIME_ENTRY_REPORT_ROW_SCHEMA
>;
export type TimeEntryReport = v.InferOutput<typeof TIME_ENTRY_REPORT_SCHEMA>;
