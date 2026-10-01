import { expect, mock, test } from "bun:test";

import { ACTION_COST_RETENTION_BATCH_SIZE } from "@/api/lib/usage/action-costs/retention";

import { drainActionCosts } from "./action-cost-retention";

for (const table of ["calls", "records"] as const) {
  test(`saturated ${table} retention schedules a durable immediate continuation`, async () => {
    const scheduleContinuation = mock((_at: Date) => {});
    const sweep = mock(async () => ({
      callsDeleted: table === "calls" ? ACTION_COST_RETENTION_BATCH_SIZE : 0,
      recordsDeleted:
        table === "records" ? ACTION_COST_RETENTION_BATCH_SIZE : 0,
    }));
    const before = Date.now();
    await drainActionCosts({
      signal: new AbortController().signal,
      sweep,
      scheduleContinuation,
    });
    expect(sweep.mock.calls.length).toBeGreaterThan(0);
    expect(sweep.mock.calls.length).toBeLessThanOrEqual(16);
    expect(scheduleContinuation).toHaveBeenCalledTimes(1);
    const nextRunAt = scheduleContinuation.mock.calls.at(0)?.at(0);
    expect(nextRunAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(nextRunAt?.getTime()).toBeLessThanOrEqual(Date.now());
  });
}

test("drained or cancelled retention does not schedule more work", async () => {
  const scheduleContinuation = mock((_at: Date) => {});
  const sweep = mock(async () => ({ callsDeleted: 0, recordsDeleted: 0 }));
  await drainActionCosts({
    signal: new AbortController().signal,
    sweep,
    scheduleContinuation,
  });
  const controller = new AbortController();
  controller.abort();
  await drainActionCosts({
    signal: controller.signal,
    sweep,
    scheduleContinuation,
  });
  expect(sweep).toHaveBeenCalledTimes(1);
  expect(scheduleContinuation).not.toHaveBeenCalled();
});
