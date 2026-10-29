import { expect, test } from "bun:test";

import type { BackgroundReplayTickReport } from "@/api/handlers/case-law/ingestion/background-replay";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { createCaseLawStoredReplayTask } from "@/api/lib/scheduler/tasks/case-law-stored-replay";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const report = (status: BackgroundReplayTickReport["status"]) =>
  ({
    status,
    source: null,
    attempted: 0,
    applied: 0,
    blocked: 0,
    errors: 0,
    failed: 0,
    retryExhausted: 0,
    retryTerminal: 0,
    heldTooLong: false,
  }) satisfies BackgroundReplayTickReport;

test("a replay time ceiling requests a continuation while governor holds yield to the next scheduled run", async () => {
  for (const status of [
    "time-limit",
    "held",
    "complete",
    "empty",
    "failed",
  ] as const) {
    const continuations: Date[] = [];
    const controller = new AbortController();
    const task = createCaseLawStoredReplayTask(async (signal) => {
      expect(signal.aborted).toBe(false);
      return report(status);
    });
    const context = asTestRaw<SchedulerTaskContext>({
      signal: controller.signal,
      dueAt: DueSlot.of({ nextRunAt: new Date("2026-01-01T00:00:00Z") }),
      scheduleContinuation: (next: Date) => {
        continuations.push(next);
      },
    });
    const result = await task(context);
    expect(continuations.length).toBe(status === "time-limit" ? 1 : 0);
    expect(result?.isErr()).toBe(status === "failed");
  }
});
