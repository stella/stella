import { Result } from "better-result";

import { sanitizeErrorAttributesForOutput } from "@stll/errors";

import type { SafeDb } from "@/api/db/safe-db";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { errorTag } from "@/api/lib/errors/error-tag";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";
import type { FileComparisonSweepError } from "@/api/lib/uploads/file-comparison/sweep";
import {
  FILE_COMPARISON_SWEEP_LIMIT,
  sweepExpiredFileComparisonUploads,
} from "@/api/lib/uploads/file-comparison/sweep";

export const SWEEP_FILE_COMPARISON_UPLOADS_TASK =
  "fileComparisons.sweepExpired" as const;

const FILE_COMPARISON_SWEEP_MAX_BATCHES = 8;
const FILE_COMPARISON_SWEEP_MAX_DURATION_MS = 60_000;

type SweepDependencies = {
  maxBatches?: number;
  maxDurationMs?: number;
  now?: () => number;
  rootSafeDb?: SafeDb;
  sweep?: typeof sweepExpiredFileComparisonUploads;
};

export const createSweepFileComparisonUploadsTask =
  ({
    maxBatches = FILE_COMPARISON_SWEEP_MAX_BATCHES,
    maxDurationMs = FILE_COMPARISON_SWEEP_MAX_DURATION_MS,
    now = () => performance.now(),
    rootSafeDb,
    sweep = sweepExpiredFileComparisonUploads,
  }: SweepDependencies = {}): SchedulerTask =>
  /**
   * Comparison staging is the one storage class no later call is obliged to
   * clean up: an agent that reserves two uploads and never compares them, or a
   * client whose PUT never lands, leaves rows and possibly objects behind. The
   * sweep is what makes the expiry in the row real.
   */
  async ({ db, logger, runId, signal }) => {
    signal.throwIfAborted();
    const safeDb =
      rootSafeDb ??
      (async (run) =>
        await Result.tryPromise(
          async () => await withAggregateTransaction(db, run),
        ));
    const deadline = now() + maxDurationMs;
    const summary = { scanned: 0, sweptUploads: 0, failed: 0 };
    let failure: FileComparisonSweepError | undefined;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      signal.throwIfAborted();
      // db-await-in-loop: sweep one bounded page per round, up to maxBatches.
      const page = await sweep({
        limit: FILE_COMPARISON_SWEEP_LIMIT,
        safeDb,
        signal,
      });
      const pageSummary = Result.isError(page)
        ? page.error.summary
        : page.value;
      summary.scanned += pageSummary.scanned;
      summary.sweptUploads += pageSummary.sweptUploads;
      summary.failed += pageSummary.failed;
      if (Result.isError(page)) {
        failure = page.error;
        break;
      }
      if (
        pageSummary.scanned < FILE_COMPARISON_SWEEP_LIMIT ||
        now() >= deadline
      ) {
        break;
      }
    }
    const outcome = failure ? Result.err(failure) : Result.ok(summary);

    const { sweptUploads } = summary;
    const audit = await Result.tryPromise({
      try: async () =>
        await recordSystemAudit(db, "system:file-comparison-sweep", {
          subject: runId,
          counts: { sweptUploads },
        }),
      catch: (cause) => cause,
    });
    logger.info(
      "scheduler.file_comparison_uploads_swept",
      sanitizeErrorAttributesForOutput({
        "fileComparisonUploads.swept": sweptUploads,
        "fileComparisonUploads.scanned": summary.scanned,
        "fileComparisonUploads.failed": summary.failed,
      }),
    );
    if (Result.isError(outcome)) {
      if (Result.isError(audit)) {
        logger.warn(
          "file_comparison.sweep_audit_failed",
          sanitizeErrorAttributesForOutput({
            "error.type": errorTag(audit.error),
          }),
        );
      }
      return Result.err(
        new SchedulerTaskFailure({
          cause: outcome.error,
          message: outcome.error.message,
        }),
      );
    }
    if (Result.isError(audit)) {
      return Result.err(
        new SchedulerTaskFailure({
          cause: audit.error,
          message: "Comparison expiry audit failed",
        }),
      );
    }
    return Result.ok(undefined);
  };

export const sweepFileComparisonUploads =
  createSweepFileComparisonUploadsTask();
