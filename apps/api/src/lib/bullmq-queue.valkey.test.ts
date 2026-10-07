import { Panic, TaggedError, UnhandledException } from "better-result";
import { DelayedError, Queue, UnrecoverableError } from "bullmq";
import type { WorkerListener } from "bullmq";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { withTimeout } from "@stll/concurrency/with-timeout";
import { assertProperty } from "@stll/property-testing";

import { BULLMQ_QUEUE_HOSTS, BullMqWorker } from "@/api/lib/bullmq-queue";
import { createBullMqConnection } from "@/api/lib/redis-client";

class QueueProbeError extends TaggedError("QueueProbeError")<{
  message: string;
  cause: unknown;
}> {}

const enabled = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";
const SETTLE_TIMEOUT_MS = 5000;
const ATTEMPTS = 3;

const failureCases = (marker: string) => {
  const failures = [
    {
      type: "tagged",
      error: new QueueProbeError({
        message: "Application failure",
        cause: new Error(marker),
      }),
    },
    { type: "panic", error: new Panic({ message: marker }) },
    {
      type: "unhandled",
      error: new UnhandledException({ cause: new Error(marker) }),
    },
    { type: "library", error: new Error(marker) },
    { type: "terminal", error: new UnrecoverableError(marker) },
  ] as const;
  for (const { error } of failures) {
    // Bun's native stack formatting can omit the message. The probe owns its
    // sensitive trace so it tests queue sanitization independently of that.
    error.stack = `${error.name}: ${marker}\n    at queueFailureProbe (${marker}:1:1)`;
  }
  return failures;
};

type ProbeData = { failure: ReturnType<typeof failureCases>[number]["type"] };

describe.skipIf(!enabled)("queue failure records over Valkey", () => {
  test("every registered queue stores fixed failure records", async () => {
    await assertProperty(
      "every registered queue stores fixed failure records",
      fc.asyncProperty(fc.string({ maxLength: 64 }), async (suffix) => {
        const marker = `SENTINEL_QUEUE_TEXT_${suffix}`;
        const failures = failureCases(marker);
        for (const queueName of Object.keys(BULLMQ_QUEUE_HOSTS)) {
          const prefix = `queue-failure-probe-${Bun.randomUUIDv7()}`;
          const queueConnection = createBullMqConnection({
            storeClass: "durable-coordination",
          });
          const workerConnection = createBullMqConnection({
            storeClass: "durable-coordination",
          });
          const queue = new Queue<ProbeData>(queueName, {
            connection: queueConnection,
            prefix,
          });
          const worker = new BullMqWorker<ProbeData>(
            queueName,
            async ({ data }) => {
              const selected = failures.find(
                ({ type }) => type === data.failure,
              );
              if (selected === undefined) {
                throw new TypeError("Unknown probe failure");
              }
              throw selected.error;
            },
            { connection: workerConnection, prefix },
          );
          const workerErrors: Error[] = [];
          worker.on("error", (error) => {
            workerErrors.push(error);
          });
          queue.on("error", (error) => {
            workerErrors.push(error);
          });
          try {
            await Promise.all([
              queue.waitUntilReady(),
              worker.waitUntilReady(),
            ]);
            for (const { type: failure, error: original } of failures) {
              const originalStack = original.stack;
              const originalMessage = original.message;
              expect(originalStack).toContain(marker);
              let nextFailure = Promise.withResolvers<Error>();
              const observed: Error[] = [];
              const onFailed: WorkerListener<ProbeData, void>["failed"] = (
                job,
                error,
              ) => {
                if (job?.name !== failure) {
                  return;
                }
                observed.push(error);
                nextFailure.resolve(error);
              };
              worker.on("failed", onFailed);
              await queue.add(
                failure,
                { failure },
                {
                  attempts: ATTEMPTS,
                  jobId: failure,
                  backoff: { type: "fixed", delay: 60_000 },
                },
              );
              const expectedAttempts =
                original instanceof UnrecoverableError ? 1 : ATTEMPTS;
              for (let attempt = 1; attempt <= expectedAttempts; attempt += 1) {
                const pendingFailure = nextFailure.promise;
                const eventError = await withTimeout(
                  async () => await pendingFailure,
                  {
                    label: "queue failure probe",
                    timeoutMs: SETTLE_TIMEOUT_MS,
                  },
                );
                expect(eventError).toBe(original);
                expect(eventError.message).toBe(originalMessage);
                expect(eventError.stack).toBe(originalStack);
                const stored = await queue.getJob(failure);
                if (stored === undefined) {
                  throw new TypeError("Probe job must be retained");
                }
                expect(stored.attemptsMade).toBe(attempt);
                expect(stored.failedReason).toBe("Queue job failed");
                expect(stored.stacktrace).toEqual([]);
                expect(
                  JSON.stringify({
                    failedReason: stored.failedReason,
                    stacktrace: stored.stacktrace,
                  }),
                ).not.toContain(marker);
                if (attempt === expectedAttempts) {
                  expect(await stored.getState()).toBe("failed");
                  continue;
                }
                // Inspect each persisted attempt before explicitly releasing its retry.
                expect(await stored.getState()).toBe("delayed");
                nextFailure = Promise.withResolvers<Error>();
                await stored.promote();
              }
              worker.off("failed", onFailed);
              expect(observed).toHaveLength(
                original instanceof UnrecoverableError ? 1 : ATTEMPTS,
              );
              expect(observed.every((error) => error === original)).toBe(true);
            }
            expect(workerErrors).toEqual([]);
          } finally {
            await worker.close();
            await queue.obliterate({ force: true });
            await queue.close();
            queueConnection.disconnect();
            workerConnection.disconnect();
          }
        }
      }),
      { numRuns: 3 },
    );
  }, 120_000);

  test("a delayed processor keeps its scheduling transition", async () => {
    const prefix = `queue-delay-probe-${Bun.randomUUIDv7()}`;
    const queueConnection = createBullMqConnection({
      storeClass: "durable-coordination",
    });
    const workerConnection = createBullMqConnection({
      storeClass: "durable-coordination",
    });
    const queue = new Queue("flow-run", {
      connection: queueConnection,
      prefix,
    });
    const delayed = Promise.withResolvers<undefined>();
    const worker = new BullMqWorker(
      queue.name,
      async (job, token) => {
        await job.moveToDelayed(Date.now() + 60_000, token);
        delayed.resolve(undefined);
        throw new DelayedError();
      },
      { connection: workerConnection, prefix },
    );
    const errors: Error[] = [];
    worker.on("error", (error) => {
      errors.push(error);
    });
    const failed: Error[] = [];
    worker.on("failed", (_job, error) => {
      failed.push(error);
    });
    try {
      const job = await queue.add("delayed", {});
      await withTimeout(async () => await delayed.promise, {
        label: "delay probe",
        timeoutMs: SETTLE_TIMEOUT_MS,
      });
      await worker.close();
      if (job.id === undefined) {
        throw new TypeError("Probe job must have an id");
      }
      const stored = await queue.getJob(job.id);
      expect(await stored?.getState()).toBe("delayed");
      expect(stored?.failedReason).toBeUndefined();
      expect(failed).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      queueConnection.disconnect();
      workerConnection.disconnect();
    }
  });
});
