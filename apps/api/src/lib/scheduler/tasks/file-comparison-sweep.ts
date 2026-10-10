import { panic, Result } from "better-result";

import { sanitizeErrorAttributesForOutput } from "@stll/errors";

import type { SafeDb } from "@/api/db/safe-db";
import { errorTag } from "@/api/lib/errors/error-tag";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";
import {
  FILE_COMPARISON_SWEEP_LIMIT,
  sweepExpiredFileComparisonUploads,
} from "@/api/lib/uploads/file-comparison/sweep";

export const SWEEP_FILE_COMPARISON_UPLOADS_TASK =
  "fileComparisons.sweepExpired" as const;

type SweepDependencies = {
  rootSafeDb?: SafeDb;
  sweep?: typeof sweepExpiredFileComparisonUploads;
};

export const createSweepFileComparisonUploadsTask =
  ({
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
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const outcome = await sweep({
      limit: FILE_COMPARISON_SWEEP_LIMIT,
      safeDb:
        rootSafeDb ??
        (async (run) =>
          await Result.tryPromise(async () => await db.transaction(run))),
      signal,
    });

    const summary = Result.isError(outcome)
      ? outcome.error.summary
      : outcome.value;
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
