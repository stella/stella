import { expect, mock, test } from "bun:test";

import { createDispatchNativeExtractionTask } from "@/api/lib/scheduler/tasks/document-processing-native-extraction";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const DUE_AT = new Date("2026-11-01T10:00:00.000Z");

const runTask = async (moreQueued: boolean) => {
  const order: string[] = [];
  const continuations: Date[] = [];
  const extractInline = mock(async () => {
    order.push("inline");
    return await Promise.resolve({ attempted: 1, failed: 0, moreQueued });
  });
  const task = createDispatchNativeExtractionTask(async () => {
    order.push("enqueue");
    await Promise.resolve();
  }, extractInline);
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => await Promise.resolve([]),
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => await Promise.resolve() }),
    }),
  };
  await task(
    asTestRaw<SchedulerTaskContext>({
      db,
      dueAt: { toDate: () => DUE_AT },
      logger: { info: () => undefined },
      scheduleContinuation: (nextRunAt: Date) => {
        continuations.push(nextRunAt);
      },
      signal: new AbortController().signal,
    }),
  );
  return { continuations, extractInline };
};

test("small runs are extracted on every tick", async () => {
  const { continuations, extractInline } = await runTask(false);

  expect(extractInline).toHaveBeenCalledTimes(1);
  expect(continuations).toEqual([]);
});

test("a full inline batch brings the next tick forward", async () => {
  const { continuations } = await runTask(true);

  expect(continuations).toHaveLength(1);
  expect(continuations.at(0)?.getTime()).toBeGreaterThan(DUE_AT.getTime());
});
