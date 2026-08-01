import { panic } from "better-result";

import { dispatchQueuedDocumentProcessingRuns } from "@/api/lib/document-processing-queue";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const DISPATCH_DOCUMENT_OCR_TASK =
  "documentProcessing.dispatchOcr" as const;

const DISPATCH_BATCH_SIZE = 100;
const MAX_DISPATCHED_RUNS_PER_TICK = 10_000;
const DISPATCH_CONTINUATION_DELAY_MS = 60_000;

type DispatchDocumentOcrBatchesOptions = {
  dispatch?: typeof dispatchQueuedDocumentProcessingRuns;
  signal: AbortSignal;
};

type DispatchDocumentOcrBatchesResult = {
  dispatched: number;
  reachedLimit: boolean;
};

export const dispatchDocumentOcrBatches = async ({
  dispatch = dispatchQueuedDocumentProcessingRuns,
  signal,
}: DispatchDocumentOcrBatchesOptions): Promise<DispatchDocumentOcrBatchesResult> => {
  let dispatched = 0;

  while (!signal.aborted && dispatched < MAX_DISPATCHED_RUNS_PER_TICK) {
    const limit = Math.min(
      DISPATCH_BATCH_SIZE,
      MAX_DISPATCHED_RUNS_PER_TICK - dispatched,
    );
    // oxlint-disable-next-line no-await-in-loop -- sequential bounded drain prevents an unbounded queue fan-out
    const batchCount = await dispatch({ limit });
    dispatched += batchCount;

    if (batchCount < limit) {
      break;
    }
  }

  return {
    dispatched,
    reachedLimit: dispatched >= MAX_DISPATCHED_RUNS_PER_TICK,
  };
};

/** Release durable OCR requests in bounded batches at the configured cadence. */
export const dispatchDocumentOcr: SchedulerTask = async ({
  logger,
  scheduleContinuation,
  signal,
}) => {
  const { dispatched, reachedLimit } = await dispatchDocumentOcrBatches({
    signal,
  });

  logger.info("scheduler.document_ocr_dispatched", {
    "documentProcessing.runs": dispatched,
  });

  if (signal.aborted) {
    panic("SchedulerAborted");
  }

  if (reachedLimit) {
    // A full final batch may hide more eligible rows. Continue promptly; an
    // unnecessary empty follow-up is bounded and cheaper than delaying backlog.
    scheduleContinuation(new Date(Date.now() + DISPATCH_CONTINUATION_DELAY_MS));
  }
};
