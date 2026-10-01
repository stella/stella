import { Result } from "better-result";
import { DelayedError } from "bullmq";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import {
  BACKGROUND_ACTION_KIND,
  QUEUED_ACTION_KIND,
} from "@/api/lib/rate-limit/action-kinds";

import { ActionAdmissionError, withActionAdmission } from "./action-admission";
import {
  admissionRetryDelayMs,
  runBackgroundJob,
  runQueuedKickoff,
} from "./queued-action-admission";

const organizationId = toSafeId<"organization">("queued_org");
const userId = toSafeId<"user">("queued_user");
const admissionPolicy = {
  organizationConcurrency: 2,
  userConcurrency: 2,
  leaseMs: 120_000,
};
const periodPolicy = { periodMs: 86_400_000, limit: 10 };

describe("queued action admission", () => {
  test("defers a busy or unavailable background job without running it", async () => {
    for (const reason of ["busy", "unavailable"] as const) {
      let ran = false;
      const delays: { timestamp: number; token: string | undefined }[] = [];
      const admission: typeof withActionAdmission = async () =>
        Result.err(
          new ActionAdmissionError({
            message: `admission ${reason}`,
            reason,
          }),
        );
      const controller = new AbortController();

      const operation = runBackgroundJob({
        actionKind: BACKGROUND_ACTION_KIND.flow,
        organizationId,
        userId,
        job: {
          token: "bull-lock-token",
          moveToDelayed: async (timestamp, token) => {
            delays.push({ timestamp, token });
          },
        },
        signal: controller.signal,
        now: () => 1234,
        admission,
        run: async () => {
          ran = true;
        },
      });

      expect(await operation.catch((error: unknown) => error)).toBeInstanceOf(
        DelayedError,
      );
      expect(ran).toBe(false);
      expect(delays).toHaveLength(1);
      expect(delays.at(0)?.timestamp).toBeGreaterThan(1234);
      expect(delays.at(0)?.token).toBe("bull-lock-token");
    }
  });

  test("combines caller timeout and admission lease loss signals", async () => {
    for (const source of ["job-timeout", "lease-loss"] as const) {
      const lease = new AbortController();
      const jobTimeout = new AbortController();
      let executionSignal: AbortSignal | undefined;
      const admission: typeof withActionAdmission = async ({
        run,
        execution,
        actionKind,
        periodIdentity,
      }) => {
        expect(execution).toBe("background-job");
        expect(actionKind).toBe(BACKGROUND_ACTION_KIND.flow);
        expect(periodIdentity).toBeUndefined();
        return await Result.tryPromise({
          try: async () => await run(lease.signal),
          catch: (error: unknown) => error,
        });
      };

      const result = await runBackgroundJob({
        actionKind: BACKGROUND_ACTION_KIND.flow,
        organizationId,
        userId,
        job: { moveToDelayed: async () => undefined },
        signal: jobTimeout.signal,
        admission,
        run: async (signal) => {
          executionSignal = signal;
          return "started";
        },
      });

      expect(result).toBe("started");
      expect(executionSignal).toBeDefined();
      const reason = new Error(source);
      (source === "job-timeout" ? jobTimeout : lease).abort(reason);
      expect(executionSignal?.aborted).toBe(true);
      expect(executionSignal?.reason).toBe(reason);
    }
  });

  test("feature flag off runs a queued kickoff without opening admission storage", async () => {
    const previous = env.FEATURE_ACTION_ADMISSION;
    env.FEATURE_ACTION_ADMISSION = false;
    try {
      expect(
        await runQueuedKickoff({
          organizationId,
          userId,
          actionKind: QUEUED_ACTION_KIND.flow,
          logicalPhaseId: "manual-run:request-1",
          run: async () => "completed",
        }),
      ).toBe("completed");
    } finally {
      env.FEATURE_ACTION_ADMISSION = previous;
    }
  });

  test("queued kickoff sends its stable phase identity to admission", async () => {
    const calls: Parameters<typeof withActionAdmission>[0][] = [];
    const admission: typeof withActionAdmission = async (options) => {
      calls.push(options);
      return await Result.tryPromise({
        try: async () => await options.run(new AbortController().signal),
        catch: (error: unknown) => error,
      });
    };

    expect(
      await runQueuedKickoff({
        organizationId,
        userId,
        actionKind: QUEUED_ACTION_KIND.extraction,
        logicalPhaseId: "server-run-7",
        admission,
        run: async () => "accepted",
      }),
    ).toBe("accepted");

    expect(calls).toHaveLength(1);
    expect(calls.at(0)).toMatchObject({
      execution: "queued-kickoff",
      periodIdentity: {
        actionKind: QUEUED_ACTION_KIND.extraction,
        logicalPhaseId: "server-run-7",
      },
    });
  });

  test("a deferred period refusal rejects kickoff before enqueue", async () => {
    const previous = env.FEATURE_ACTION_ADMISSION;
    env.FEATURE_ACTION_ADMISSION = true;
    let enqueued = false;
    const admission: typeof withActionAdmission = async (options) =>
      await withActionAdmission({
        ...options,
        enabled: true,
        policy: admissionPolicy,
        periodPolicy,
        redis: {
          send: async (_command, args) => {
            const script = args.at(0) ?? "";
            if (script.includes("ZREMRANGEBYSCORE")) {
              return 1;
            }
            return script.includes("HEXISTS") ? -1 : 1;
          },
        },
      });
    try {
      expect(
        await runQueuedKickoff({
          organizationId,
          userId,
          actionKind: QUEUED_ACTION_KIND.flow,
          logicalPhaseId: "refused-run",
          periodReservation: "on-acceptance",
          admission,
          run: async (_signal, reservePeriod) => {
            await reservePeriod();
            enqueued = true;
          },
        }).catch((error: unknown) => error),
      ).toBeInstanceOf(ActionAdmissionError);
      expect(enqueued).toBe(false);
    } finally {
      env.FEATURE_ACTION_ADMISSION = previous;
    }
  });

  test("holds the admission lease until planning and enqueue work settles", async () => {
    const calls: string[][] = [];
    const redis = {
      send: async (_command: string, args: string[]) => {
        calls.push(args);
        return 1;
      },
    };
    const planningStarted = Promise.withResolvers<undefined>();
    const finishPlanningAndEnqueue = Promise.withResolvers<undefined>();
    const admission: typeof withActionAdmission = async (options) =>
      await withActionAdmission({
        ...options,
        enabled: true,
        policy: admissionPolicy,
        periodPolicy,
        redis,
      });

    const operation = runQueuedKickoff({
      organizationId,
      userId,
      actionKind: QUEUED_ACTION_KIND.flow,
      logicalPhaseId: "manual-run:request-2",
      admission,
      run: async () => {
        planningStarted.resolve(undefined);
        await finishPlanningAndEnqueue.promise;
        return "enqueued";
      },
    });

    await planningStarted.promise;
    expect(
      calls.filter((args) => args.at(0)?.includes("ZREMRANGEBYSCORE")),
    ).toHaveLength(1);
    expect(
      calls.some((args) => args.at(0)?.includes('redis.call("ZREM",')),
    ).toBe(false);

    finishPlanningAndEnqueue.resolve(undefined);
    expect(await operation).toBe("enqueued");
    expect(
      calls.filter((args) => args.at(0)?.includes('redis.call("ZREM",')),
    ).toHaveLength(1);
  });
  test("denied contenders spread their retries and progress after the owner settles", async () => {
    let active = 0;
    let completed = 0;
    const entered = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const redis = {
      send: async (_command: string, args: string[]) => {
        if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
          if (active === 1) {
            return 0;
          }
          active += 1;
          return 1;
        }
        if (args.at(0)?.includes('redis.call("ZREM",')) {
          active -= 1;
        }
        return 1;
      },
    };
    const admission: typeof withActionAdmission = async (options) =>
      await withActionAdmission({
        ...options,
        enabled: true,
        redis,
        policy: {
          organizationConcurrency: 1,
          userConcurrency: 1,
          leaseMs: 120_000,
        },
      });
    const owner = runBackgroundJob({
      actionKind: BACKGROUND_ACTION_KIND.flow,
      organizationId,
      userId,
      admission,
      job: { moveToDelayed: async () => undefined },
      signal: new AbortController().signal,
      run: async () => {
        entered.resolve(undefined);
        await finish.promise;
      },
    });
    await entered.promise;
    const deferred: { index: number; at: number }[] = [];
    const contender = async (index: number) =>
      await runBackgroundJob({
        actionKind: BACKGROUND_ACTION_KIND.flow,
        organizationId,
        userId,
        admission,
        now: () => 0,
        random: () => index / 32,
        job: {
          attemptsStarted: 1,
          moveToDelayed: async (at) => {
            deferred.push({ index, at });
          },
        },
        signal: new AbortController().signal,
        run: async () => {
          completed += 1;
        },
      });
    const firstAttempts = await Promise.allSettled(
      Array.from({ length: 32 }, async (_, index) => await contender(index)),
    );
    expect(
      firstAttempts.every(
        (result) =>
          result.status === "rejected" && result.reason instanceof DelayedError,
      ),
    ).toBe(true);
    expect(new Set(deferred.map(({ at }) => at)).size).toBe(32);
    expect(completed).toBe(0);
    finish.resolve(undefined);
    await owner;
    // Advance the simulated queue to each distinct scheduled retry; no sleeps or hot-loop.
    for (const { index } of deferred.toSorted(
      (left, right) => left.at - right.at,
    )) {
      await contender(index);
    }
    expect(completed).toBe(32);
    expect(active).toBe(0);
    expect(admissionRetryDelayMs(1, () => 0)).toBe(1000);
    expect(admissionRetryDelayMs(1, () => 0.999)).toBeLessThan(10_000);
    expect(admissionRetryDelayMs(2, () => 0.999)).toBeGreaterThan(10_000);
    expect(admissionRetryDelayMs(100, () => 0.999)).toBeLessThanOrEqual(60_000);
  });
});
