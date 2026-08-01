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
  retryAt: Date | null;
};

export const nextDocumentOcrDispatchAt = ({
  now,
  reachedLimit,
  retryAt,
}: {
  now: Date;
  reachedLimit: boolean;
  retryAt: Date | null;
}): Date | undefined => {
  const capContinuationAt = reachedLimit
    ? new Date(now.getTime() + DISPATCH_CONTINUATION_DELAY_MS)
    : undefined;
  if (!retryAt) {
    return capContinuationAt;
  }
  if (!capContinuationAt || retryAt < capContinuationAt) {
    return retryAt;
  }
  return capContinuationAt;
};

export const dispatchDocumentOcrBatches = async ({
  dispatch = dispatchQueuedDocumentProcessingRuns,
  signal,
}: DispatchDocumentOcrBatchesOptions): Promise<DispatchDocumentOcrBatchesResult> => {
  let dispatched = 0;
  let retryAt: Date | null = null;

  while (!signal.aborted && dispatched < MAX_DISPATCHED_RUNS_PER_TICK) {
    const limit = Math.min(
      DISPATCH_BATCH_SIZE,
      MAX_DISPATCHED_RUNS_PER_TICK - dispatched,
    );
    // oxlint-disable-next-line no-await-in-loop -- sequential bounded drain prevents an unbounded queue fan-out
    const batch = await dispatch({ limit });
    dispatched += batch.attempted;
    if (batch.retryAt && (!retryAt || batch.retryAt < retryAt)) {
      retryAt = batch.retryAt;
    }

    if (batch.attempted < limit) {
      break;
    }
  }

  return {
    dispatched,
    reachedLimit: dispatched >= MAX_DISPATCHED_RUNS_PER_TICK,
    retryAt,
  };
};

/** Release durable OCR requests in bounded batches at the configured cadence. */
export const dispatchDocumentOcr: SchedulerTask = async ({
  logger,
  scheduleContinuation,
  signal,
}) => {
  const { dispatched, reachedLimit, retryAt } =
    await dispatchDocumentOcrBatches({ signal });

  logger.info("scheduler.document_ocr_dispatched", {
    "documentProcessing.runs": dispatched,
  });

  if (signal.aborted) {
    panic("SchedulerAborted");
  }

  const continuationAt = nextDocumentOcrDispatchAt({
    now: new Date(),
    reachedLimit,
    retryAt,
  });
  if (continuationAt) {
    // A full final batch may hide more eligible rows, while a failed handoff has
    // a durable retry deadline. Use the earlier bounded continuation.
    scheduleContinuation(continuationAt);
  }
};
