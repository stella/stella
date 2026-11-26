import { describe, expect, test } from "bun:test";

import { settledWithin } from "@stll/test-kit";

import {
  API_SHUTDOWN_OUTCOME,
  shutdownApiServices,
} from "@/api/server-shutdown";

const observeWithinDeadline = async <T>(operation: Promise<T>) =>
  await settledWithin(operation, {
    description: "API service stop to settle",
    timeoutMs: 3000,
  });

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
      stopChatQueueSender: () => {
        events.push("chat-queue-sender-stopped");
      },
      stopChatLimitResumer: () => {
        events.push("chat-limit-resumer-stopped");
      },
      stopChatTurnAdopter: () => {
        events.push("chat-turn-adopter-stopped");
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
      "chat-queue-sender-stopped",
      "chat-limit-resumer-stopped",
      "chat-turn-adopter-stopped",
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
        stopChatQueueSender: () => undefined,
        stopChatLimitResumer: () => undefined,
        stopChatTurnAdopter: () => undefined,
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
          stopChatQueueSender: () => undefined,
          stopChatLimitResumer: () => undefined,
          stopChatTurnAdopter: () => undefined,
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
