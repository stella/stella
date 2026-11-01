import { Result } from "better-result";
import { afterEach, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  createExtractNativeInlineTask,
  runInlineExtractions,
} from "@/api/lib/scheduler/tasks/document-processing-inline-extraction";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const db = asTestRaw<SchedulerDb>({});
const runId = (index: number) =>
  toSafeId<"documentProcessingRun">(
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
const runsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: runId(index) }));

const reportFailure = mock(() => undefined);

afterEach(() => {
  reportFailure.mockClear();
});

test("processes one run at a time, in order", async () => {
  let active = 0;
  let peak = 0;
  const seen: SafeId<"documentProcessingRun">[] = [];
  const process = mock(
    async (_db: SchedulerDb, id: SafeId<"documentProcessingRun">) => {
      active++;
      peak = Math.max(peak, active);
      seen.push(id);
      await Promise.resolve();
      active--;
    },
  );

  const result = await runInlineExtractions({
    db,
    process,
    reportFailure,
    runs: runsOf(3),
    signal: new AbortController().signal,
  });

  expect(result).toEqual({ attempted: 3, failed: 0 });
  expect(peak).toBe(1);
  expect(seen).toEqual([runId(0), runId(1), runId(2)]);
});

test("a failed run does not stop the files behind it", async () => {
  const failure = new Error("unreadable");
  const process = mock(
    async (_db: SchedulerDb, id: SafeId<"documentProcessingRun">) => {
      await Promise.resolve();
      if (id === runId(0)) {
        throw failure;
      }
    },
  );

  const result = await runInlineExtractions({
    db,
    process,
    reportFailure,
    runs: runsOf(3),
    signal: new AbortController().signal,
  });

  expect(result).toEqual({ attempted: 3, failed: 1 });
  expect(process).toHaveBeenCalledTimes(3);
  expect(reportFailure).toHaveBeenCalledTimes(1);
  expect(reportFailure).toHaveBeenCalledWith({
    error: failure,
    job: { data: { runId: runId(0) } },
  });
});

test("starts nothing after scheduler cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const process = mock(async () => undefined);

  const outcome = await Result.tryPromise(
    async () =>
      await runInlineExtractions({
        db,
        process,
        reportFailure,
        runs: runsOf(1),
        signal: controller.signal,
      }),
  );

  expect(Result.isError(outcome)).toBe(true);
  expect(process).not.toHaveBeenCalled();
});

const runTask = async (queued: number) => {
  const continuations: Date[] = [];
  const process = mock(async () => undefined);
  const readRuns = mock(async () => runsOf(queued));
  const dueAt = new Date("2026-11-01T10:00:00.000Z");
  const context = {
    db,
    dueAt: { toDate: () => dueAt },
    logger: { info: () => undefined },
    scheduleContinuation: (nextRunAt: Date) => {
      continuations.push(nextRunAt);
    },
    signal: new AbortController().signal,
  };
  await createExtractNativeInlineTask({ process, readRuns, reportFailure })(
    asTestRaw<SchedulerTaskContext>(context),
  );
  return { continuations, process, readRuns };
};

test("a full batch comes back soon, a partial one waits for its schedule", async () => {
  const full = await runTask(LIMITS.documentProcessingInlineBatchSize);
  expect(full.continuations).toHaveLength(1);
  expect(full.process).toHaveBeenCalledTimes(
    LIMITS.documentProcessingInlineBatchSize,
  );

  const partial = await runTask(1);
  expect(partial.continuations).toEqual([]);
});
