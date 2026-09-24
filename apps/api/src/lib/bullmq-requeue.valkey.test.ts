import { Queue, Worker } from "bullmq";
import type { Job, JobsOptions } from "bullmq";
import { afterEach, describe, expect, test } from "bun:test";

import { createBullMqConnection } from "@/api/lib/redis-client";

import {
  QUEUE_REQUEUE_OUTCOME,
  requeueDeterministicJob,
} from "./bullmq-requeue";

const redisUrl = process.env["REDIS_URL"];
const runValkeyTests = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";

const JOB_NAME = "requeue-probe";
const JOB_ID = "probe";
const SETTLE_TIMEOUT_MS = 5000;

type ProbeData = { generation: number };

type ProbeProcessor = (job: Job<ProbeData>) => Promise<void>;

type Harness = {
  queue: Queue<ProbeData>;
  // Every run the worker started, in order, with the data it received.
  runs: ProbeData[];
  // Resolves when the worker has settled `count` jobs (completed or failed).
  settled: (count: number) => Promise<void>;
  startWorker: () => void;
};

const closers: (() => Promise<void>)[] = [];

// Retention matches the production queues: terminal records are kept, which
// is what makes a plain `add` under a reused id a no-op.
const KEEP_TERMINAL: JobsOptions = { removeOnComplete: 100, removeOnFail: 500 };

const createHarness = (processor: ProbeProcessor, attempts = 1): Harness => {
  const queueName = `requeue-test-${Bun.randomUUIDv7()}`;
  const queue = new Queue<ProbeData>(queueName, {
    connection: createBullMqConnection(),
    defaultJobOptions: { ...KEEP_TERMINAL, attempts },
  });
  const runs: ProbeData[] = [];
  let settledCount = 0;
  const waiters: { count: number; resolve: () => void }[] = [];
  const onSettled = () => {
    settledCount += 1;
    for (const waiter of waiters.filter(({ count }) => count <= settledCount)) {
      waiter.resolve();
    }
  };
  let worker: Worker<ProbeData> | undefined;

  closers.push(async () => {
    await worker?.close(true);
    await queue.obliterate({ force: true });
    await queue.close();
  });

  return {
    queue,
    runs,
    settled: async (count) => {
      if (settledCount >= count) {
        return;
      }
      const { promise, resolve } = Promise.withResolvers<undefined>();
      waiters.push({ count, resolve: () => resolve(undefined) });
      const timer = setTimeout(() => resolve(undefined), SETTLE_TIMEOUT_MS);
      await promise;
      clearTimeout(timer);
      expect(settledCount).toBeGreaterThanOrEqual(count);
    },
    startWorker: () => {
      worker = new Worker<ProbeData>(
        queueName,
        async (job) => {
          runs.push(job.data);
          await processor(job);
        },
        { connection: createBullMqConnection() },
      );
      worker.on("completed", onSettled);
      worker.on("failed", onSettled);
    },
  };
};

const requeue = async (queue: Queue<ProbeData>, generation: number) =>
  await requeueDeterministicJob({
    data: { generation },
    jobId: JOB_ID,
    name: JOB_NAME,
    queue,
  });

const succeed: ProbeProcessor = async () => {};

if (!redisUrl || !runValkeyTests) {
  describe.skip("deterministic job requeue (valkey)", () => {
    test("requires STELLA_RUN_VALKEY_TESTS=true and REDIS_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("deterministic job requeue (valkey)", () => {
    afterEach(async () => {
      await Promise.all(closers.splice(0).map(async (close) => await close()));
    });

    test("a completed job runs again", async () => {
      const harness = createHarness(succeed);
      harness.startWorker();

      expect(await requeue(harness.queue, 1)).toBe(
        QUEUE_REQUEUE_OUTCOME.REQUEUED,
      );
      await harness.settled(1);
      expect(await harness.queue.getJobState(JOB_ID)).toBe("completed");

      expect(await requeue(harness.queue, 2)).toBe(
        QUEUE_REQUEUE_OUTCOME.REQUEUED,
      );
      await harness.settled(2);
      expect(harness.runs).toEqual([{ generation: 1 }, { generation: 2 }]);
    });

    test("a failed job is retried with the queue's full attempt budget", async () => {
      // Fails its first three runs: the original two attempts, then the first
      // attempt after the requeue. The requeued job only completes when it gets
      // a second attempt of its own.
      let failuresLeft = 3;
      const harness = createHarness(async () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("probe failure");
        }
      }, 2);
      harness.startWorker();

      await requeue(harness.queue, 1);
      await harness.settled(2);
      expect(await harness.queue.getJobState(JOB_ID)).toBe("failed");

      expect(await requeue(harness.queue, 2)).toBe(
        QUEUE_REQUEUE_OUTCOME.REQUEUED,
      );
      await harness.settled(4);
      expect(await harness.queue.getJobState(JOB_ID)).toBe("completed");
      // A retry reruns the job under its own data.
      expect(harness.runs).toHaveLength(4);
      expect(harness.runs.every(({ generation }) => generation === 1)).toBe(
        true,
      );
    });

    test("a live job counts as owned and is not duplicated", async () => {
      const release = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<undefined>();
      const harness = createHarness(async () => {
        started.resolve(undefined);
        await release.promise;
      });

      await harness.queue.add(
        JOB_NAME,
        { generation: 1 },
        { delay: 60_000, jobId: JOB_ID },
      );
      expect(await requeue(harness.queue, 2)).toBe(
        QUEUE_REQUEUE_OUTCOME.QUEUE_OWNED,
      );
      expect(await harness.queue.getJobState(JOB_ID)).toBe("delayed");

      await harness.queue.remove(JOB_ID);
      await requeue(harness.queue, 3);
      expect(await requeue(harness.queue, 4)).toBe(
        QUEUE_REQUEUE_OUTCOME.QUEUE_OWNED,
      );

      harness.startWorker();
      await started.promise;
      expect(await requeue(harness.queue, 5)).toBe(
        QUEUE_REQUEUE_OUTCOME.QUEUE_OWNED,
      );
      release.resolve(undefined);
      await harness.settled(1);

      expect(harness.runs).toEqual([{ generation: 3 }]);
    });

    test("a kept completed id is re-added and runs", async () => {
      const harness = createHarness(succeed);
      harness.startWorker();

      await requeue(harness.queue, 1);
      await harness.settled(1);

      // The kept record swallows a plain add under the same id.
      await harness.queue.add(JOB_NAME, { generation: 2 }, { jobId: JOB_ID });
      expect(await harness.queue.getJobState(JOB_ID)).toBe("completed");

      expect(
        await requeueDeterministicJob({
          data: { generation: 3 },
          jobId: JOB_ID,
          name: JOB_NAME,
          queue: harness.queue,
          reclaimData: ({ data: { generation } }) => ({
            generation: generation + 10,
          }),
        }),
      ).toBe(QUEUE_REQUEUE_OUTCOME.REQUEUED);
      await harness.settled(2);

      expect(harness.runs).toEqual([{ generation: 1 }, { generation: 11 }]);
    });
  });
}
