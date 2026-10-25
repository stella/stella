import { panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { processStoredDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";

type ApplyStoredDecisionBackfillOptions = {
  report: { applied: number; deferred: number };
  row: {
    id: SafeId<"caseLawDecision">;
    sourceHash: string | null;
    sourceRawS3Key: string;
  };
  result: IngestionResult;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  sourceLease: CaseLawSourceIngestionLease;
};

/** An extra source surface extends the stored input without redefining the crawl's hash. */
export const applyStoredDecisionBackfill = async (
  {
    report,
    row,
    result,
    sourceId,
    scopedDb,
    sourceLease,
  }: ApplyStoredDecisionBackfillOptions,
  {
    processDecision = processStoredDecision,
    allocateObservationOrder = allocateSourceObservationOrder,
  } = {},
) => {
  await sourceLease.beforeDatabaseMark();
  const outcome = await processDecision({
    input: { ...result, rawHash: row.sourceHash ?? result.rawHash },
    sourceId,
    scopedDb,
    decisionId: row.id,
    sourceRawS3Key: row.sourceRawS3Key,
    observedAt: new Date(),
    observationOrder: await allocateObservationOrder({
      leaseToken: sourceLease.leaseToken,
      scopedDb,
      sourceId,
    }),
  });
  switch (outcome.status) {
    case PROCESS_DECISION_STATUS.COMPLETE:
      if (outcome.inserted) {
        report.applied += 1;
      }
      return;
    case PROCESS_DECISION_STATUS.RETRYABLE:
      report.deferred += 1;
      return;
    default:
      outcome satisfies never;
      panic("Unhandled stored-decision backfill outcome");
  }
};
