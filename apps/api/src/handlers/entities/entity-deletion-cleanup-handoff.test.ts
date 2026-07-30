import { expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

import { handoffCommittedEntityDeletionCleanup } from "./entity-deletion-cleanup-handoff";

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
