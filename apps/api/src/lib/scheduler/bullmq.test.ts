import { describe, expect, mock, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/api/lib/branded-types";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type AddCall = {
  queueName: string;
  name: string;
  data: unknown;
  opts: unknown;
};
const addCalls: AddCall[] = [];
const constructedQueues: string[] = [];

class MockQueue {
  readonly queueName: string;

  constructor(queueName: string) {
    this.queueName = queueName;
    constructedQueues.push(queueName);
  }

  async add(name: string, data: unknown, opts: unknown) {
    addCalls.push({ queueName: this.queueName, name, data, opts });
    return { id: "queued" };
  }
}

// Spread the real modules: mock.module is process-global; a partial mock would
// delete the module's other exports for later test files.
const realBullmq = await import("bullmq");
void mock.module("bullmq", () => ({ ...realBullmq, Queue: MockQueue }));
const { createBullMqConnection } = await import("@/api/lib/redis-client");
const { createBullMqDispatchTask } = await import("@/api/lib/scheduler/bullmq");
const { QUEUE_AUTHORITY } = await import("@/api/lib/member-run-queues");

type ContextOptions = {
  nextRunAt?: Date;
  payload?: unknown;
  runId?: SchedulerTaskContext["runId"];
};

const occurrence = new Date("2026-06-14T12:00:00.000Z");

const context = ({
  nextRunAt = occurrence,
  payload = { queueName: "document-processing", jobName: "sendDigest" },
  runId = toSafeId<"schedulerJobRun">("run_1"),
}: ContextOptions = {}): SchedulerTaskContext =>
  asTestRaw<SchedulerTaskContext>({
    job: { id: "job_1", nextRunAt },
    payload,
    runId,
  });

const reset = () => {
  addCalls.length = 0;
  constructedQueues.length = 0;
};

describe("createBullMqDispatchTask idempotency", () => {
  test("deduplicates retries for the same scheduled occurrence", async () => {
    reset();
    const task = createBullMqDispatchTask({
      createConnection: createBullMqConnection,
    });

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
    reset();
    const task = createBullMqDispatchTask({
      createConnection: createBullMqConnection,
    });

    await task(context());
    await task(context({ nextRunAt: new Date("2026-06-15T12:00:00.000Z") }));

    expect(addCalls[0]?.opts).not.toEqual(addCalls[1]?.opts);
  });
});

describe("createBullMqDispatchTask target queue", () => {
  test("dispatches to an org-automation queue", async () => {
    reset();
    const task = createBullMqDispatchTask({
      createConnection: createBullMqConnection,
    });

    await task(
      context({
        payload: {
          queueName: "entity-deletion-cleanup",
          jobName: "sweep",
          data: { batch: 1 },
        },
      }),
    );

    expect(addCalls).toEqual([
      expect.objectContaining({
        queueName: "entity-deletion-cleanup",
        name: "sweep",
        data: expect.objectContaining({ payload: { batch: 1 } }),
      }),
    ]);
  });

  test.each(
    Object.entries(QUEUE_AUTHORITY)
      .filter(([, { authority }]) => authority === "member-run")
      .map(([queue]) => queue),
  )(
    "refuses member-run queue %s without constructing a queue",
    async (queueName) => {
      const authority = "member-run";
      reset();
      const task = createBullMqDispatchTask({
        createConnection: createBullMqConnection,
      });

      const run = Promise.resolve(
        task(context({ payload: { queueName, jobName: "run" } })),
      );

      expect(await rejectionOf(run)).toMatchObject({
        _tag: "ConfigurationError",
        message: expect.stringContaining(`${authority} queue ${queueName}`),
      });
      expect(constructedQueues).toEqual([]);
      expect(addCalls).toEqual([]);
    },
  );

  test.each(["emails", "", "__proto__", "toString"])(
    "refuses unknown queue name %p without constructing a queue",
    async (queueName) => {
      reset();
      const task = createBullMqDispatchTask({
        createConnection: createBullMqConnection,
      });

      const run = Promise.resolve(
        task(context({ payload: { queueName, jobName: "run" } })),
      );

      expect(await rejectionOf(run)).toMatchObject({
        _tag: "ConfigurationError",
        message: expect.stringContaining("unknown BullMQ queue"),
      });
      expect(constructedQueues).toEqual([]);
      expect(addCalls).toEqual([]);
    },
  );

  test("refuses a malformed payload", async () => {
    reset();
    const task = createBullMqDispatchTask({
      createConnection: createBullMqConnection,
    });

    const run = Promise.resolve(
      task(context({ payload: { queueName: "document-processing" } })),
    );

    expect(await rejectionOf(run)).toMatchObject({
      _tag: "ConfigurationError",
    });
    expect(constructedQueues).toEqual([]);
  });
});
