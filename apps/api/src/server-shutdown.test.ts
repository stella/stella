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
      closeManagedProviderChecks: async () => undefined,
      closeBackgroundWorkers: async () => undefined,
      closeDatabaseLoginProbe: async () => undefined,
      drainScheduler: Promise.resolve(),
      onHttpStopError: () => undefined,
      relinquishChatTurnRuns: async () => {
        events.push("chat-turn-runs-relinquished");
        return await Promise.resolve("stored" as const);
      },
      stopHttp: async () => {
        events.push("http-stop-started");
        await httpStopped.promise;
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
      "chat-turn-runs-relinquished",
    ]);
  });

  test("bounds shutdown when HTTP and worker draining never settle", async () => {
    const never = Promise.withResolvers<undefined>().promise;
    const neverRunEnd = Promise.withResolvers<"stored" | "unstored">().promise;

    const outcome = observeWithinDeadline(
      shutdownApiServices({
        closeManagedProviderChecks: async () => undefined,
        closeBackgroundWorkers: async () => await never,
        closeDatabaseLoginProbe: async () => await never,
        drainScheduler: never,
        onHttpStopError: () => undefined,
        relinquishChatTurnRuns: async () => await neverRunEnd,
        stopHttp: async () => await never,
        stopScheduler: () => undefined,
        stopSse: () => undefined,
        timeout: Promise.resolve(),
      }),
    );

    expect(await outcome).toBe(API_SHUTDOWN_OUTCOME.timedOut);
  });

  for (const failedService of [
    "chat-turn-runs",
    "http",
    "login-probe",
    "provider-checks",
    "scheduler",
    "workers",
  ] as const) {
    test(`reports failed ${failedService} cleanup`, async () => {
      const failure = new Error(`${failedService} cleanup failed`);
      const loggedErrors: unknown[] = [];
      const never = Promise.withResolvers<undefined>().promise;

      const outcome = await observeWithinDeadline(
        shutdownApiServices({
          closeManagedProviderChecks: async () => {
            if (failedService === "provider-checks") {
              throw failure;
            }
          },
          closeBackgroundWorkers: async () => {
            if (failedService === "workers") {
              throw failure;
            }
          },
          closeDatabaseLoginProbe: async () => {
            if (failedService === "login-probe") {
              throw failure;
            }
          },
          drainScheduler:
            failedService === "scheduler"
              ? Promise.reject(failure)
              : Promise.resolve(),
          onHttpStopError: (error) => {
            loggedErrors.push(error);
          },
          // A run that could not store its outcome fails the drain.
          relinquishChatTurnRuns: async () =>
            await Promise.resolve(
              failedService === "chat-turn-runs" ? "unstored" : "stored",
            ),
          stopHttp: async () => {
            if (failedService === "http") {
              throw failure;
            }
          },
          stopScheduler: () => undefined,
          stopSse: () => undefined,
          timeout: never,
        }),
      );

      expect(outcome).toBe(API_SHUTDOWN_OUTCOME.failed);
      expect(loggedErrors).toEqual(failedService === "http" ? [failure] : []);
    });
  }
});
