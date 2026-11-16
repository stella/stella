import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  emitCaseLawFreshnessReport,
  readCaseLawFreshnessReportTx,
} from "@/api/lib/observability/case-law-freshness-metrics";
import {
  emitCorpusProjectionUnservedReport,
  observeCorpusProjectionUnservedReportFailure,
  readCorpusProjectionUnservedReportTx,
} from "@/api/lib/observability/corpus-index-projection-unserved-report";
import {
  observeSplitCensusFailure,
  readServedGenerationsForCensusTx,
  reportCorpusIndexSplitCensus,
} from "@/api/lib/observability/corpus-index-split-census";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REPORT_CASE_LAW_FRESHNESS_TASK =
  "caseLaw.reportFreshness" as const;

export const reportCaseLawFreshnessTask: SchedulerTask = async ({
  db,
  dueAt,
}) => {
  const report = await withAggregateTransaction(
    db,
    readCaseLawFreshnessReportTx,
  );
  emitCaseLawFreshnessReport(report);
  // The unserved gauge and the split census are telemetry: each failure is
  // observed on its own sink and leaves the freshness task's outcome alone.
  const unserved = await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(db, readCorpusProjectionUnservedReportTx),
    catch: (error: unknown) => error,
  });
  if (Result.isError(unserved)) {
    observeCorpusProjectionUnservedReportFailure(unserved.error);
  } else if (Result.isError(unserved.value)) {
    observeCorpusProjectionUnservedReportFailure(unserved.value.error);
  } else {
    // Ages are judged at the claim, the instant the report's reads follow.
    emitCorpusProjectionUnservedReport(
      unserved.value.value,
      Temporal.Instant.fromEpochMilliseconds(dueAt.claimedAtDate().getTime()),
    );
  }
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
