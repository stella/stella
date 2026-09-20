import { panic, Result } from "better-result";

import { rootDb } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
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
    rootSafeDb = async (run) =>
      await Result.tryPromise(async () => await rootDb.transaction(run)),
    sweep = sweepExpiredFileComparisonUploads,
  }: SweepDependencies = {}): SchedulerTask =>
  /**
   * Comparison staging is the one storage class no later call is obliged to
   * clean up: an agent that reserves two uploads and never compares them, or a
   * client whose PUT never lands, leaves rows and possibly objects behind. The
   * sweep is what makes the expiry in the row real.
   */
  async ({ logger, signal }) => {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const sweptUploads = await sweep({
      limit: FILE_COMPARISON_SWEEP_LIMIT,
      safeDb: rootSafeDb,
      signal,
    });

    logger.info("scheduler.file_comparison_uploads_swept", {
      "fileComparisonUploads.swept": sweptUploads,
    });
  };

export const sweepFileComparisonUploads =
  createSweepFileComparisonUploadsTask();
