import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type AddCall = { name: string; data: unknown; opts: unknown };
const addCalls: AddCall[] = [];

class MockQueue {
  async add(name: string, data: unknown, opts: unknown) {
    addCalls.push({ name, data, opts });
    return { id: "queued" };
  }
}

// Spread the real modules: mock.module is process-global; a partial mock would
// delete the module's other exports for later test files.
const realBullmq = await import("bullmq");
void mock.module("bullmq", () => ({ ...realBullmq, Queue: MockQueue }));
const realRedisClient = await import("@/api/lib/redis-client");
void mock.module("@/api/lib/redis-client", () => ({
  ...realRedisClient,
  createBullMqConnection: () => ({}),
  createRedisClient: () => ({}),
}));

const { createBullMqDispatchTask } = await import("@/api/lib/scheduler/bullmq");

type ContextOptions = {
  nextRunAt?: Date;
  runId?: SchedulerTaskContext["runId"];
};

const occurrence = new Date("2026-06-14T12:00:00.000Z");

const context = ({
  nextRunAt = occurrence,
  runId = toSafeId<"schedulerJobRun">("run_1"),
}: ContextOptions = {}): SchedulerTaskContext =>
  asTestRaw<SchedulerTaskContext>({
    job: { id: "job_1", nextRunAt },
    payload: { queueName: "emails", jobName: "sendDigest" },
    runId,
  });

describe("createBullMqDispatchTask idempotency", () => {
  test("deduplicates retries for the same scheduled occurrence", async () => {
    addCalls.length = 0;
    const task = createBullMqDispatchTask();

    await task(context());
    await task(context({ runId: toSafeId<"schedulerJobRun">("run_2") }));

    expect(addCalls).toHaveLength(2);
    for (const call of addCalls) {
      expect(call.name).toBe("sendDigest");
      expect(call.opts).toMatchObject({
        jobId: "scheduler-job_1-2026%2D06%2D14T12%3A00%3A00.000Z",
      });
    }
    expect(addCalls[0]?.opts).toEqual(addCalls[1]?.opts);
    expect(addCalls[0]?.data).toMatchObject({ schedulerRunId: "run_1" });
    expect(addCalls[1]?.data).toMatchObject({ schedulerRunId: "run_2" });
  });

  test("uses a different jobId for a different scheduled occurrence", async () => {
    addCalls.length = 0;
    const task = createBullMqDispatchTask();

    await task(context());
    await task(context({ nextRunAt: new Date("2026-06-15T12:00:00.000Z") }));

    expect(addCalls[0]?.opts).not.toEqual(addCalls[1]?.opts);
  });
});
