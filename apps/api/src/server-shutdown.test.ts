import { describe, expect, test } from "bun:test";

import {
  API_SHUTDOWN_OUTCOME,
  shutdownApiServices,
} from "@/api/server-shutdown";

const TEST_DEADLINE_MS = 100;

const observeWithinDeadline = async <T>(operation: Promise<T>) =>
  await Promise.race([
    operation,
    Bun.sleep(TEST_DEADLINE_MS).then(() => "test-deadline" as const),
  ]);

describe("API service shutdown", () => {
  test("closes long-lived SSE streams without waiting for HTTP stop first", async () => {
    const httpStopped = Promise.withResolvers<undefined>();
    const never = Promise.withResolvers<undefined>().promise;
    const events: string[] = [];

    const shutdown = shutdownApiServices({
      closeBackgroundWorkers: async () => undefined,
      drainScheduler: Promise.resolve(),
      onHttpStopError: () => undefined,
      stopHttp: () => {
        events.push("http-stop-started");
        return httpStopped.promise;
      },
      stopScheduler: () => {
        events.push("scheduler-stopped");
      },
      stopSse: () => {
        events.push("sse-stopped");
        httpStopped.resolve(undefined);
      },
      timeout: never,
    });

    expect(await observeWithinDeadline(shutdown)).toBe(
      API_SHUTDOWN_OUTCOME.drained,
    );
    expect(events).toEqual([
      "http-stop-started",
      "sse-stopped",
      "scheduler-stopped",
    ]);
  });

  test("bounds shutdown when HTTP and worker draining never settle", async () => {
    const never = Promise.withResolvers<undefined>().promise;

    const outcome = observeWithinDeadline(
      shutdownApiServices({
        closeBackgroundWorkers: () => never,
        drainScheduler: never,
        onHttpStopError: () => undefined,
        stopHttp: () => never,
        stopScheduler: () => undefined,
        stopSse: () => undefined,
        timeout: Promise.resolve(),
      }),
    );

    expect(await outcome).toBe(API_SHUTDOWN_OUTCOME.timedOut);
  });
});
