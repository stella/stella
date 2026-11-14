import { panic } from "better-result";

import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { dispatchQueuedDocumentProcessingRuns } from "@/api/lib/document-processing-queue";
import { extractSmallRunsInline } from "@/api/lib/scheduler/tasks/document-processing-inline-extraction";
import {
  dispatchDocumentOcrBatches,
  nextDocumentOcrDispatchAt,
} from "@/api/lib/scheduler/tasks/document-processing-ocr";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const DISPATCH_NATIVE_EXTRACTION_TASK =
  "documentProcessing.dispatchNativeExtraction" as const;

const MORE_QUEUED_CONTINUATION_DELAY_MS = 10_000;

/**
 * Re-delivers native extraction runs whose post-commit queue handoff was lost,
 * then extracts the small ones here so they do not wait for the batch worker.
 * Dispatch goes first: a slow file must not hold back the handoff.
 */
export const createDispatchNativeExtractionTask =
  (
    enqueue: typeof enqueueDocumentProcessingRun = enqueueDocumentProcessingRun,
    extractInline: typeof extractSmallRunsInline = extractSmallRunsInline,
  ): SchedulerTask =>
  async ({ db, dueAt, logger, scheduleContinuation, signal }) => {
    const { dispatched, reachedLimit, retryAt } =
      await dispatchDocumentOcrBatches({
        dispatch: async ({ limit }) =>
          await dispatchQueuedDocumentProcessingRuns({
            database: db,
            enqueue,
            limit,
            selection: {
              kind: "native-extraction",
              scheduledRetriesOnly: false,
            },
          }),
        signal,
      });

    logger.info("scheduler.document_native_extraction_dispatched", {
      "documentProcessing.runs": dispatched,
    });

    const inline = await extractInline({ db, signal });
    logger.info("scheduler.document_native_extraction_inline", {
      "documentProcessing.failed": inline.failed,
      "documentProcessing.runs": inline.attempted,
    });

    if (signal.aborted) {
      panic("SchedulerAborted");
    }

    const now = dueAt.toDate();
    const dispatchAt = nextDocumentOcrDispatchAt({
      now,
      reachedLimit,
      retryAt,
    });
    const inlineAt = inline.moreQueued
      ? new Date(now.getTime() + MORE_QUEUED_CONTINUATION_DELAY_MS)
      : undefined;
    const continuationAt =
      dispatchAt && inlineAt
        ? new Date(Math.min(dispatchAt.getTime(), inlineAt.getTime()))
        : (dispatchAt ?? inlineAt);
    if (continuationAt) {
      scheduleContinuation(continuationAt);
    }
  };

export const dispatchNativeExtraction = createDispatchNativeExtractionTask();
