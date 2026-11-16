import { panic, Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import {
  handleDocumentProcessingFailure,
  processDocumentProcessingRun,
  readInlineNativeExtractionRuns,
} from "@/api/lib/document-processing-queue";
import { LIMITS } from "@/api/lib/limits";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

type RunExtractionOptions = {
  db: SchedulerDb;
  process: typeof processDocumentProcessingRun;
  reportFailure: typeof handleDocumentProcessingFailure;
  runs: readonly { id: SafeId<"documentProcessingRun"> }[];
  signal: AbortSignal;
};

/**
 * One run at a time: parsing happens in a subprocess, so this leaves the event
 * loop free, but each one still holds its file in memory here. A failed run is
 * settled by its own owner, reported the way the worker reports it, and must
 * not stop the files behind it.
 */
export const runInlineExtractions = async ({
  db,
  process,
  reportFailure,
  runs,
  signal,
}: RunExtractionOptions): Promise<{ attempted: number; failed: number }> => {
  let attempted = 0;
  let failed = 0;
  for (const run of runs) {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    attempted++;
    const outcome = await Result.tryPromise(
      // db-await-in-loop: one file at a time is the bound on this process's memory
      async () => await process(db, run.id, signal),
    );
    if (Result.isError(outcome)) {
      failed++;
      reportFailure({
        error: outcome.error.cause,
        job: { data: { runId: run.id } },
      });
    }
  }
  return { attempted, failed };
};

type ExtractSmallRunsOptions = {
  db: SchedulerDb;
  process?: typeof processDocumentProcessingRun;
  readRuns?: typeof readInlineNativeExtractionRuns;
  reportFailure?: typeof handleDocumentProcessingFailure;
  signal: AbortSignal;
};

/**
 * Extracts small uploads in the API process, so their text is searchable
 * within minutes. The scheduled batch worker keeps larger files and OCR; both
 * claim through the run's own lease, so a run cannot be processed twice.
 */
export const extractSmallRunsInline = async ({
  db,
  process = processDocumentProcessingRun,
  readRuns = readInlineNativeExtractionRuns,
  reportFailure = handleDocumentProcessingFailure,
  signal,
}: ExtractSmallRunsOptions) => {
  const limit = LIMITS.documentProcessingInlineBatchSize;
  const runs = await readRuns({ database: db, limit });
  const { attempted, failed } = await runInlineExtractions({
    db,
    process,
    reportFailure,
    runs,
    signal,
  });
  return { attempted, failed, moreQueued: runs.length === limit };
};
