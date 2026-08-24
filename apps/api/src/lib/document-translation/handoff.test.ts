import { expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

import { handoffCommittedDocumentTranslationRun } from "./handoff";

const ids = {
  organizationId: toSafeId<"organization">("org_test"),
  runId: toSafeId<"documentTranslationRun">(
    "00000000-0000-0000-0000-000000000001",
  ),
  userId: toSafeId<"user">("user_test"),
  workspaceId: toSafeId<"workspace">("00000000-0000-0000-0000-000000000002"),
};

test("preserves a committed translation run when queue delivery stalls", async () => {
  const captureDeliveryError = mock(() => {});
  const enqueue = mock(async () => await new Promise<void>(() => {}));

  await handoffCommittedDocumentTranslationRun({
    ...ids,
    captureDeliveryError,
    enqueue,
    timeoutMs: 5,
  });

  expect(enqueue).toHaveBeenCalledWith(ids);
  expect(captureDeliveryError).toHaveBeenCalledWith(expect.any(TimeoutError), {
    runId: ids.runId,
    workspaceId: ids.workspaceId,
  });
});

test("captures queue rejection without failing the committed run", async () => {
  const captureDeliveryError = mock(() => {});
  const enqueue = mock(async () => {
    await Promise.reject(new Error("redis unavailable"));
  });

  await handoffCommittedDocumentTranslationRun({
    ...ids,
    captureDeliveryError,
    enqueue,
  });

  expect(captureDeliveryError).toHaveBeenCalledTimes(1);
});
