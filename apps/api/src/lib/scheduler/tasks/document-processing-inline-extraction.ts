import { panic, Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import {
  processDocumentProcessingRun,
  readInlineNativeExtractionRuns,
} from "@/api/lib/document-processing-queue";
import { LIMITS } from "@/api/lib/limits";
import type {
  SchedulerDb,
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";

export const EXTRACT_NATIVE_INLINE_TASK =
  "documentProcessing.extractNativeInline" as const;

const FULL_BATCH_CONTINUATION_DELAY_MS = 10_000;

type RunExtractionOptions = {
  db: SchedulerDb;
  process: typeof processDocumentProcessingRun;
  runs: readonly { id: SafeId<"documentProcessingRun"> }[];
  signal: AbortSignal;
};

/**
 * One run at a time: parsing happens in a subprocess, so this leaves the event
 * loop free, but each one still holds its file in memory here. A failed run is
 * settled by its own owner and must not stop the files behind it.
 */
export const runInlineExtractions = async ({
  db,
  process,
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
    }
  }
  return { attempted, failed };
};

type InlineExtractionDependencies = {
  process?: typeof processDocumentProcessingRun;
  readRuns?: typeof readInlineNativeExtractionRuns;
};

/**
 * Extracts small uploads in the API process, so their text is searchable
 * within minutes. The scheduled batch worker keeps larger files and OCR; both
 * claim through the run's own lease, so a run cannot be processed twice.
 */
export const createExtractNativeInlineTask =
  ({
    process = processDocumentProcessingRun,
    readRuns = readInlineNativeExtractionRuns,
  }: InlineExtractionDependencies = {}): SchedulerTask =>
  async ({
    db,
    dueAt,
    logger,
    scheduleContinuation,
    signal,
  }: SchedulerTaskContext) => {
    const limit = LIMITS.documentProcessingInlineBatchSize;
    const runs = await readRuns({ database: db, limit });
    const { attempted, failed } = await runInlineExtractions({
      db,
      process,
      runs,
      signal,
    });

    logger.info("scheduler.document_native_extraction_inline", {
      "documentProcessing.failed": failed,
      "documentProcessing.runs": attempted,
    });

    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    if (runs.length === limit) {
      scheduleContinuation(
        new Date(dueAt.toDate().getTime() + FULL_BATCH_CONTINUATION_DELAY_MS),
      );
    }
  };

export const extractNativeInline = createExtractNativeInlineTask();
