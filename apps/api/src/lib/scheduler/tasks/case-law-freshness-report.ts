import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  emitCaseLawFreshnessReport,
  readCaseLawFreshnessReportTx,
} from "@/api/lib/observability/case-law-freshness-metrics";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REPORT_CASE_LAW_FRESHNESS_TASK =
  "caseLaw.reportFreshness" as const;

export const reportCaseLawFreshnessTask: SchedulerTask = async ({ db }) => {
  const report = await withAggregateTransaction(
    db,
    readCaseLawFreshnessReportTx,
  );
  emitCaseLawFreshnessReport(report);
};
