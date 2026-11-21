import { panic, Result } from "better-result";
import { expect, mock, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/api/lib/branded-types";
import { SanctionsDrainAttemptFailed } from "@/api/lib/lists/sanctions/monitoring-drain";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createDrainSanctionsMonitoringTask } from "./sanctions-monitoring";

const now = new Date("2026-10-05T12:00:00.000Z");
const organizations = Array.from({ length: 9 }, (_, index) => ({
  organizationId: toSafeId<"organization">(`synthetic-drain-${index}`),
}));
const taskContext = (count: number) => {
  const scheduleContinuation = mock((_at: Date) => {});
  const warn = mock((_message: string, _fields: unknown) => {});
  const query = {
    from: () => query,
    where: () => query,
    groupBy: () => query,
    orderBy: () => query,
    limit: async (limit: number) =>
      organizations.slice(0, Math.min(count, limit)),
  };
  const controller = new AbortController();
  const context = asTestRaw<SchedulerTaskContext>({
    db: { select: () => query },
    dueAt: DueSlot.of({ nextRunAt: now }),
    signal: controller.signal,
    logger: { warn, info: () => undefined },
    scheduleContinuation,
  });
  return { context, controller, scheduleContinuation, warn };
};
const unrecordedFailure = async () => {
  const result = await Result.tryPromise(async () => {
    throw new TypeError("Synthetic unrecorded drain failure");
  });
  if (result.isOk()) {
    return panic("Expected the injected drain failure");
  }
  return result;
};

test.each(Array.from({ length: 8 }, (_, index) => index))(
  "an unrecorded failure at page position %i preserves every other organization's drain",
  async (failedIndex) => {
    const failure = await unrecordedFailure();
    const visited: string[] = [];
    const { context, scheduleContinuation, warn } = taskContext(8);
    const task = createDrainSanctionsMonitoringTask(
      async ({ organizationId }) => {
        visited.push(organizationId);
        return organizationId === organizations.at(failedIndex)?.organizationId
          ? failure
          : Result.ok({ claimed: 1, terminal: 1, hasMore: false });
      },
    );
    const outcome = await task(context);
    expect(visited).toEqual(
      organizations.slice(0, 8).map(({ organizationId }) => organizationId),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.cause).toEqual([failure.error]);
    }
    expect(warn).toHaveBeenCalledWith(
      "scheduler.sanctions_monitoring_drain_failed",
      { "sanctions.failure_code": "unrecorded" },
    );
    expect(scheduleContinuation).toHaveBeenCalledWith(
      new Date(now.getTime() + 1000),
    );
  },
);

test("multiple failures remain visible while backed-off attempts preserve the bounded page", async () => {
  const failure = await unrecordedFailure();
  const backedOff = new SanctionsDrainAttemptFailed({
    message: "Synthetic backed-off attempt",
    cause: failure.error,
  });
  const { context, scheduleContinuation, warn } = taskContext(9);
  const visited: string[] = [];
  const task = createDrainSanctionsMonitoringTask(
    async ({ organizationId }) => {
      visited.push(organizationId);
      return visited.length <= 2 ? failure : Result.err(backedOff);
    },
  );
  const outcome = await task(context);
  expect(visited).toHaveLength(8);
  expect(visited).not.toContain(organizations.at(8)?.organizationId);
  expect(outcome.isErr()).toBe(true);
  if (outcome.isErr()) {
    expect(outcome.error.cause).toEqual([failure.error, failure.error]);
  }
  expect(warn).toHaveBeenCalledWith(
    "scheduler.sanctions_monitoring_drain_failed",
    { "sanctions.failure_code": "attempt-backed-off" },
  );
  expect(scheduleContinuation).toHaveBeenCalledTimes(1);
});

test("a recorded backoff succeeds without scheduling an immediate retry", async () => {
  const { context, scheduleContinuation } = taskContext(1);
  const task = createDrainSanctionsMonitoringTask(async () =>
    Result.err(
      new SanctionsDrainAttemptFailed({
        message: "Synthetic backed-off attempt",
        cause: new TypeError("Synthetic failure"),
      }),
    ),
  );
  expect((await task(context)).isOk()).toBe(true);
  expect(scheduleContinuation).not.toHaveBeenCalled();
});

test("a sole unrecorded failure returns failure without a tight continuation loop", async () => {
  const failure = await unrecordedFailure();
  const { context, scheduleContinuation } = taskContext(1);
  const task = createDrainSanctionsMonitoringTask(async () => failure);
  expect((await task(context)).isErr()).toBe(true);
  expect(scheduleContinuation).not.toHaveBeenCalled();
});

test("empty and idle pages do not schedule continuation", async () => {
  for (const count of [0, 1]) {
    const { context, scheduleContinuation } = taskContext(count);
    const drain = mock(async () =>
      Result.ok({ claimed: 0, terminal: 0, hasMore: false }),
    );
    const task = createDrainSanctionsMonitoringTask(drain);
    expect((await task(context)).isOk()).toBe(true);
    expect(drain).toHaveBeenCalledTimes(count);
    expect(scheduleContinuation).not.toHaveBeenCalled();
  }
});

test("remaining contact work schedules continuation even without claimed rows", async () => {
  const { context, scheduleContinuation } = taskContext(1);
  const task = createDrainSanctionsMonitoringTask(async () =>
    Result.ok({ claimed: 0, terminal: 0, hasMore: true }),
  );
  expect((await task(context)).isOk()).toBe(true);
  expect(scheduleContinuation).toHaveBeenCalledTimes(1);
});

test("cancellation stops the page before another organization is drained", async () => {
  const { context, controller, scheduleContinuation } = taskContext(2);
  const drain = mock(async () => {
    controller.abort(new TypeError("Synthetic cancellation"));
    return await unrecordedFailure();
  });
  const task = createDrainSanctionsMonitoringTask(drain);
  expect(await rejectionOf(task(context))).toHaveProperty(
    "message",
    "Synthetic cancellation",
  );
  expect(drain).toHaveBeenCalledTimes(1);
  expect(scheduleContinuation).not.toHaveBeenCalled();
});
