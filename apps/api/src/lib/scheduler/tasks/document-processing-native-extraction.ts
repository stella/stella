import { panic } from "better-result";

import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { dispatchQueuedDocumentProcessingRuns } from "@/api/lib/document-processing-queue";
import {
  dispatchDocumentOcrBatches,
  nextDocumentOcrDispatchAt,
} from "@/api/lib/scheduler/tasks/document-processing-ocr";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const DISPATCH_NATIVE_EXTRACTION_TASK =
  "documentProcessing.dispatchNativeExtraction" as const;

/** Re-deliver native extraction runs whose post-commit queue handoff was lost. */
export const createDispatchNativeExtractionTask =
  (
    enqueue: typeof enqueueDocumentProcessingRun = enqueueDocumentProcessingRun,
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

    if (signal.aborted) {
      panic("SchedulerAborted");
    }

    const continuationAt = nextDocumentOcrDispatchAt({
      now: dueAt.toDate(),
      reachedLimit,
      retryAt,
    });
    if (continuationAt) {
      scheduleContinuation(continuationAt);
    }
  };

export const dispatchNativeExtraction = createDispatchNativeExtractionTask();
