import { Result } from "better-result";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  emitCaseLawFreshnessReport,
  readCaseLawFreshnessReportTx,
} from "@/api/lib/observability/case-law-freshness-metrics";
import {
  observeSplitCensusFailure,
  readServedGenerationsForCensusTx,
  reportCorpusIndexSplitCensus,
} from "@/api/lib/observability/corpus-index-split-census";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REPORT_CASE_LAW_FRESHNESS_TASK =
  "caseLaw.reportFreshness" as const;

export const reportCaseLawFreshnessTask: SchedulerTask = async ({ db }) => {
  const report = await withAggregateTransaction(
    db,
    readCaseLawFreshnessReportTx,
  );
  emitCaseLawFreshnessReport(report);
  // The split census is telemetry: its failure is observed on its own sink
  // and leaves the freshness task's outcome alone.
  const census = await Result.tryPromise({
    try: async () => {
      await reportCorpusIndexSplitCensus(
        await withAggregateTransaction(db, readServedGenerationsForCensusTx),
      );
    },
    catch: (error: unknown) => error,
  });
  if (Result.isError(census)) {
    observeSplitCensusFailure(census.error);
  }
};
