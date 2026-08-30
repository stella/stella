import { expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

import {
  handoffCommittedEntityDeletionCleanup,
  handoffCommittedEntityDeletionCleanupBatch,
} from "./entity-deletion-cleanup-handoff";

const requestId = toSafeId<"entityDeletionCleanupRequest">(
  "00000000-0000-0000-0000-000000000001",
);

test("preserves committed deletion success and captures a stalled delivery", async () => {
  const capturedErrors: unknown[] = [];
  const captureDeliveryError = mock((error: unknown) => {
    capturedErrors.push(error);
  });
  const neverSettles = new Promise<void>(() => {});
  const enqueueCleanup = mock(async () => {
    await neverSettles;
  });

  await handoffCommittedEntityDeletionCleanup({
    captureDeliveryError,
    enqueueCleanup,
    requestId,
    timeoutMs: 5,
  });

  expect(enqueueCleanup).toHaveBeenCalledWith(requestId);
  expect(captureDeliveryError).toHaveBeenCalledTimes(1);
  expect(capturedErrors.at(0)).toBeInstanceOf(TimeoutError);
  expect(captureDeliveryError).toHaveBeenCalledWith(expect.any(TimeoutError), {
    requestId,
  });
});

// A deletion commits one cleanup request per bounded page, so a long-lived
// document can produce many. They are all durable and the reconciler claims
// every `pending` row, so the inline hand-off must accelerate only a bounded
// prefix rather than fan out one queue call per page.
test("accelerates only a bounded prefix of a large committed batch", async () => {
  const enqueued: string[] = [];
  const enqueueCleanup = mock(async (id: string) => {
    enqueued.push(id);
  });
  const captureDeliveryError = mock(() => {});
  const requestIds = Array.from({ length: 250 }, (_, index) =>
    toSafeId<"entityDeletionCleanupRequest">(
      `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    ),
  );

  await handoffCommittedEntityDeletionCleanupBatch({
    captureDeliveryError,
    enqueueCleanup,
    requestIds,
  });

  expect(enqueued.length).toBeLessThan(requestIds.length);
  expect(enqueued.length).toBeGreaterThan(0);
  // The accelerated prefix is the head of the committed order, and the
  // remainder is left committed for reconciliation rather than dropped.
  expect(enqueued).toEqual(requestIds.slice(0, enqueued.length));
  expect(captureDeliveryError).not.toHaveBeenCalled();
});

test("captures a failed hand-off without failing the committed deletion", async () => {
  const captureDeliveryError = mock(() => {});
  const enqueueCleanup = mock(async () => {
    await Promise.reject(new Error("redis unavailable"));
  });

  await handoffCommittedEntityDeletionCleanupBatch({
    captureDeliveryError,
    enqueueCleanup,
    requestIds: [requestId],
  });

  expect(captureDeliveryError).toHaveBeenCalledTimes(1);
});

test("preserves committed deletion success when delivery telemetry fails", async () => {
  const captureDeliveryError = mock(() => {
    throw new Error("telemetry unavailable");
  });
  const enqueueCleanup = mock(async () => {
    await Promise.reject(new Error("redis unavailable"));
  });

  await expect(
    handoffCommittedEntityDeletionCleanupBatch({
      captureDeliveryError,
      enqueueCleanup,
      requestIds: [requestId],
    }),
  ).resolves.toBeUndefined();

  expect(captureDeliveryError).toHaveBeenCalledTimes(1);
});
