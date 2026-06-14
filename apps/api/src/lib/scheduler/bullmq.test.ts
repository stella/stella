import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type AddCall = { name: string; data: unknown; opts: unknown };
const addCalls: AddCall[] = [];

class MockQueue {
  add(name: string, data: unknown, opts: unknown) {
    addCalls.push({ name, data, opts });
    return Promise.resolve({ id: "queued" });
  }
}

mock.module("bullmq", () => ({ Queue: MockQueue }));
mock.module("@/api/lib/redis-client", () => ({
  createBullMqConnection: () => ({}),
  createRedisClient: () => ({}),
}));

const { createBullMqDispatchTask } = await import("@/api/lib/scheduler/bullmq");

const context = (): SchedulerTaskContext =>
  asTestRaw<SchedulerTaskContext>({
    job: { id: "job_1" },
    payload: { queueName: "emails", jobName: "sendDigest" },
    runId: toSafeId<"schedulerJobRun">("run_1"),
  });

describe("createBullMqDispatchTask idempotency", () => {
  test("enqueues with a deterministic jobId from scheduler job + run", async () => {
    addCalls.length = 0;
    const task = createBullMqDispatchTask();

    await task(context());
    await task(context()); // a re-fire of the same run

    // Both dispatches use the same jobId, so BullMQ deduplicates them.
    expect(addCalls).toHaveLength(2);
    for (const call of addCalls) {
      expect(call.name).toBe("sendDigest");
      expect(call.opts).toMatchObject({ jobId: "scheduler:job_1:run_1" });
    }
    expect(addCalls[0]?.opts).toEqual(addCalls[1]?.opts);
  });
});
