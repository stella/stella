import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const reconcileStaleBufferIntentsGloballyMock = mock(async () => 0);
const { createReconcileBufferIntentsTask } =
  await import("@/api/lib/scheduler/tasks/buffer-intent-reconciliation");

test("independently schedules one bounded fair global recovery batch", async () => {
  reconcileStaleBufferIntentsGloballyMock.mockResolvedValue(2);
  const info = mock();
  const signal = new AbortController().signal;

  await createReconcileBufferIntentsTask({
    reconcile: reconcileStaleBufferIntentsGloballyMock,
    rootSafeDb: asTestRaw<SafeDb>(async () => Result.ok(undefined)),
  })(
    asTestRaw<SchedulerTaskContext>({
      logger: { info },
      signal,
    }),
  );

  expect(reconcileStaleBufferIntentsGloballyMock).toHaveBeenCalledWith({
    safeDb: expect.any(Function),
    limit: 50,
    signal,
  });
  expect(info).toHaveBeenCalledWith("scheduler.buffer_intents_reconciled", {
    "bufferIntents.claimed": 2,
  });
});
