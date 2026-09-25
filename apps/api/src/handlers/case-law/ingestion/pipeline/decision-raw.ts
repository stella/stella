import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import type { ExistingDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
  wrappedErrorDetail,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import type { ProcessResult } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { writeOwnedRawPayload } from "@/api/handlers/case-law/ingestion/pipeline/raw-payload";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { errorSystemFields } from "@/api/lib/errors/utils";
import {
  enqueueCaseLawRawSweepTx,
  rawSweepSettleAfter,
} from "@/api/lib/legal-search/case-law-raw-sweeps";
import type {
  RawSourceWriteFailure,
  RawSourceWriteWindow,
} from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";
import { pgErrorFields } from "@/api/lib/pg-error";

/** The raw writes one decision attempt makes under its decision. */
export type RawWriteState = {
  /**
   * Opened before the read that proves the decision is not erased, so every
   * raw write the attempt makes starts within the window of that read, and
   * an erasure's settled sweep comes after all of them.
   */
  window: RawSourceWriteWindow;
  /** Set once this attempt starts writing raw objects under its decision. */
  attempted: boolean;
};

type RecordAbandonedRawWriteOptions = {
  scopedDb: ScopedDb;
  existing: ExistingDecision | undefined;
  rawWrites: RawWriteState;
  decisionId: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
};

/**
 * Raw objects this attempt wrote for a decision whose row it will not
 * insert. Whether anything may keep them depends on whether a row or a
 * reservation for the id ever lands, which the sweeper decides once every
 * write for it is over; a failure to record that is left to the census.
 */
export const recordAbandonedRawWrite = async ({
  scopedDb,
  existing,
  rawWrites,
  decisionId,
  sourceId,
}: RecordAbandonedRawWriteOptions): Promise<void> => {
  if (existing !== undefined || !rawWrites.attempted) {
    return;
  }
  const recorded = await Result.tryPromise({
    try: async () =>
      await scopedDb(async (tx) => {
        await enqueueCaseLawRawSweepTx(tx, {
          decisionId,
          sourceId,
          firstAttemptAt: rawSweepSettleAfter(),
          settleAfter: rawSweepSettleAfter(),
        });
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(recorded)) {
    captureError(recorded.error, {
      decisionId,
      sourceId,
      step: "processDecision.recordAbandonedRawWrite",
    });
  }
};

/** The raw-source pointer the row write records. */
export type SourceRawArtifact = {
  s3UploadFailed: boolean;
  sourceRawContentType: string | null;
  sourceRawS3Key: string | null;
};

type AcquireSourceRawArtifactOptions = {
  result: IngestionResult;
  existing: ExistingDecision | undefined;
  preservesExistingDetail: boolean;
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  rawWrites: RawWriteState;
};

/**
 * Acquire the raw-source artifact before persisting its hash. A new row
 * cannot safely advance without the artifact; an update preserves its old
 * key and carries a retryable failure through the eventual row outcome.
 */
export const acquireSourceRawArtifact = async ({
  result,
  existing,
  preservesExistingDetail,
  sourceId,
  decisionId,
  rawWrites,
}: AcquireSourceRawArtifactOptions) => {
  const rawContentType = result.sourceRawContentType ?? "text/plain";
  const storedRawKey = existing?.sourceRawS3Key ?? null;
  const storedRawContentType = existing?.sourceRawContentType ?? null;

  const acquired = (artifact: SourceRawArtifact) =>
    ({ type: "acquired", artifact }) as const;

  if (preservesExistingDetail && existing !== undefined) {
    return acquired({
      s3UploadFailed: false,
      sourceRawS3Key: existing.sourceRawS3Key,
      sourceRawContentType: existing.sourceRawContentType,
    });
  }

  const rawWriteFailed = (error: unknown) => {
    if (!existing) {
      // New decision: hold the page's cursor and retry the slice.
      // Inserting with sourceRawS3Key: null would set sourceHash,
      // causing the dedup check to skip it permanently — the raw
      // source would be lost forever.
      //
      // Reported as retryable rather than thrown: the decision loop
      // catches a throw, counts it as skipped, and lets the cursor
      // advance, so a forward-only traversal passes the decision and
      // never returns to it. Only a retryable outcome reaches the
      // page-level hold.
      logger.error("case_law.ingestion.source_raw_write_failed", {
        sourceId,
        caseNumber: result.caseNumber,
        ...errorSystemFields(error),
        ...pgErrorFields(error),
        "error.detail": wrappedErrorDetail(error),
      });
      captureError(error, { sourceId, step: "uploadSourceRaw" });

      return {
        type: "retry",
        outcome: {
          status: PROCESS_DECISION_STATUS.RETRYABLE,
          inserted: false,
          reason: PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE,
        },
      } as const;
    }

    captureError(error, { sourceId, step: "uploadSourceRaw" });

    // Update: preserve existing S3 key and DO NOT advance sourceHash.
    // If we wrote the new hash with the old key, the hash mismatch
    // would never trigger again and the stale raw source could never
    // be corrected through normal ingestion.
    return acquired({
      s3UploadFailed: true,
      sourceRawS3Key: existing.sourceRawS3Key,
      sourceRawContentType: existing.sourceRawContentType,
    });
  };

  /**
   * Store the payload and the files it names, answering its key, or
   * undefined when this observation carries none. Every write is
   * content-addressed and created only if absent, so a retry after a
   * failure between them lands nothing twice.
   */
  const writeRaw = async (): Promise<
    Result<string | undefined, RawSourceWriteFailure>
  > =>
    await writeOwnedRawPayload({
      result,
      sourceId,
      ownerId: decisionId,
      contentType: rawContentType,
      storedKey: storedRawKey,
      storedContentType: storedRawContentType,
      window: rawWrites.window,
      onWriteStart: () => {
        rawWrites.attempted = true;
      },
    });

  try {
    const written = await writeRaw();
    if (Result.isError(written)) {
      return rawWriteFailed(written.error);
    }
    return written.value === undefined
      ? acquired({
          s3UploadFailed: false,
          sourceRawS3Key: null,
          sourceRawContentType: null,
        })
      : acquired({
          s3UploadFailed: false,
          sourceRawS3Key: written.value,
          sourceRawContentType: rawContentType,
        });
  } catch (error) {
    return rawWriteFailed(error);
  }
};

/**
 * The raw-source retry the row carries, independent of the corpus write.
 *
 * An update whose raw upload failed kept its old `sourceHash` so the next
 * pass re-observes the decision; reporting it complete would strand that
 * retry. Every return that would otherwise report a decision this pass
 * wrote as complete goes through here, so the single-decision path and the
 * page-batch path answer the same way. A row that was redacted or removed
 * while the batch ran has nothing left to re-observe, and is reported as
 * complete with `inserted: false`, so it is left alone.
 */
export const withSourceRawRetry = (
  s3UploadFailed: boolean,
  outcome: ProcessResult,
): ProcessResult =>
  s3UploadFailed &&
  outcome.status === PROCESS_DECISION_STATUS.COMPLETE &&
  outcome.inserted
    ? {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: true,
        reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
      }
    : outcome;

type SweepRawWriteLostToErasureOptions = {
  rawWrites: RawWriteState;
  id: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
};

/**
 * This attempt wrote raw objects for a decision that was erased before
 * its row write: they landed after, or may yet land after, the erasure's
 * own sweep. Recorded in the transaction that saw the erasure, so the
 * sweeper deletes them whatever becomes of this process.
 */
export const sweepRawWriteLostToErasureTx = async (
  tx: Transaction,
  { rawWrites, id, sourceId }: SweepRawWriteLostToErasureOptions,
): Promise<void> => {
  if (!rawWrites.attempted) {
    return;
  }
  await enqueueCaseLawRawSweepTx(tx, {
    decisionId: id,
    sourceId,
    firstAttemptAt: new Date(),
    settleAfter: rawSweepSettleAfter(),
  });
};
