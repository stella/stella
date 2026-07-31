import { beforeEach, expect, mock, test } from "bun:test";

import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const transactionMock = mock();
const reconcileStaleBufferIntentsGloballyMock = mock(async () => 0);

void mock.module("@/api/db/root", () => ({
  rootDb: { transaction: transactionMock },
}));
void mock.module("@/api/lib/buffer-intent-reconciliation", () => ({
  reconcileStaleBufferIntentsGlobally: reconcileStaleBufferIntentsGloballyMock,
}));

const { reconcileBufferIntents } =
  await import("@/api/lib/scheduler/tasks/buffer-intent-reconciliation");

beforeEach(() => {
  transactionMock.mockReset();
  reconcileStaleBufferIntentsGloballyMock.mockReset();
  reconcileStaleBufferIntentsGloballyMock.mockResolvedValue(0);
});

test("independently schedules one bounded fair global recovery batch", async () => {
  reconcileStaleBufferIntentsGloballyMock.mockResolvedValue(2);
  const info = mock();

  await reconcileBufferIntents(
    asTestRaw<SchedulerTaskContext>({
      logger: { info },
      signal: new AbortController().signal,
    }),
  );

  expect(reconcileStaleBufferIntentsGloballyMock).toHaveBeenCalledWith({
    safeDb: expect.any(Function),
    limit: 50,
  });
  expect(info).toHaveBeenCalledWith("scheduler.buffer_intents_reconciled", {
    "bufferIntents.claimed": 2,
  });
});
