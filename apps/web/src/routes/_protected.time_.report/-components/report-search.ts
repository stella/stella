import * as v from "valibot";

import {
  TIME_ENTRY_REPORT_BUCKETS,
  TIME_ENTRY_REPORT_GROUPS,
  TIME_ENTRY_REPORT_PERIODS,
} from "@stll/api-contract/time-entry-report";
import { parsePlainDate } from "@stll/time";

import { routeSearchSchema } from "@/route-search-params";

const date = v.pipe(
  v.string(),
  v.check((value) => parsePlainDate(value) !== null),
);
export const reportSearchSchema = routeSearchSchema({
  period: v.optional(v.picklist(TIME_ENTRY_REPORT_PERIODS)),
  from: v.optional(date),
  to: v.optional(date),
  groupBy: v.optional(v.picklist(TIME_ENTRY_REPORT_GROUPS)),
  bucket: v.optional(v.picklist(TIME_ENTRY_REPORT_BUCKETS)),
});
export type ReportSearch = v.InferOutput<typeof reportSearchSchema>;
