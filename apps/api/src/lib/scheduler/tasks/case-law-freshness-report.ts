import { Result } from "better-result";

import { decisionTextHealthBreached } from "@/api/lib/case-law/fulltext-health";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  emitCaseLawFreshnessReport,
  readCaseLawFreshnessReportTx,
} from "@/api/lib/observability/case-law-freshness-metrics";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REPORT_CASE_LAW_FRESHNESS_TASK =
  "caseLaw.reportFreshness" as const;

export const reportCaseLawFreshnessTask: SchedulerTask = async ({ db }) => {
  const report = await withAggregateTransaction(
    db,
    readCaseLawFreshnessReportTx,
  );
  emitCaseLawFreshnessReport(report);
  if (decisionTextHealthBreached(report.fulltextHealth)) {
    return Result.err(
      new SchedulerTaskFailure({
        message: "Case-law full-text invariant health breached",
        cause: report.fulltextHealth,
      }),
    );
  }
  return Result.ok();
};
