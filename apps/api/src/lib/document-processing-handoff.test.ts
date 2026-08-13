import { expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  DOCUMENT_PROCESSING_HANDOFF_CONCURRENCY,
  handoffCommittedDocumentProcessingRuns,
} from "./document-processing-handoff";

const runIds = Array.from(
  { length: DOCUMENT_PROCESSING_HANDOFF_CONCURRENCY * 2 + 1 },
  (_, index) =>
    toSafeId<"documentProcessingRun">(
      `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    ),
);

test("drains every committed run while bounding concurrent queue handoffs", async () => {
  let active = 0;
  let maxActive = 0;
  const firstBatchGate = Promise.withResolvers<undefined>();
  const firstBatchReady = Promise.withResolvers<undefined>();
  const enqueue = mock(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === DOCUMENT_PROCESSING_HANDOFF_CONCURRENCY) {
      firstBatchReady.resolve(undefined);
    }
    await firstBatchGate.promise;
    active -= 1;
  });

  const handoff = handoffCommittedDocumentProcessingRuns({
    captureEnqueueError: mock(() => {}),
    enqueue,
    runIds,
  });

  await firstBatchReady.promise;
  expect(maxActive).toBe(DOCUMENT_PROCESSING_HANDOFF_CONCURRENCY);
  firstBatchGate.resolve(undefined);
  await handoff;

  expect(enqueue).toHaveBeenCalledTimes(runIds.length);
  expect(maxActive).toBe(DOCUMENT_PROCESSING_HANDOFF_CONCURRENCY);
});

test("captures one failed handoff and continues draining committed runs", async () => {
  const enqueueError = new Error("redis unavailable");
  const enqueue = mock(async (runId: (typeof runIds)[number]) => {
    if (runId === runIds.at(1)) {
      throw enqueueError;
    }
  });
  const captureEnqueueError = mock(() => {});

  await handoffCommittedDocumentProcessingRuns({
    captureEnqueueError,
    enqueue,
    runIds: runIds.slice(0, 3),
  });

  expect(enqueue).toHaveBeenCalledTimes(3);
  expect(captureEnqueueError).toHaveBeenCalledWith(enqueueError, {
    runId: runIds.at(1),
  });
});
