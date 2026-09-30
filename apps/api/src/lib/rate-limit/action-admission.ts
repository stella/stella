import { Result, TaggedError } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  ACTION_PERIOD_ACQUIRE_SCRIPT,
  actionPeriodArguments,
  staleActionPeriodTime,
  resolveActionPeriodBudget,
  type ActionPeriodBudget,
  type ActionPeriodIdentity,
  type ActionPeriodPolicy,
} from "@/api/lib/rate-limit/action-period-budget";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import {
  createLazyRedisClient,
  createRedisClient,
} from "@/api/lib/redis-client";
import { coordinationKey, type CoordinationKey } from "@/api/lib/redis-keys";

type RedisCommands = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

const REDIS_COMMAND_TIMEOUT_MS = 500;
const RENEW_FAILURE = failureSink({
  event: "action_admission.renew_failed",
  expected: [],
});
const RELEASE_FAILURE = failureSink({
  event: "action_admission.release_failed",
  expected: [],
});
const admissionRedis = createLazyRedisClient(() =>
  createRedisClient({
    connectionTimeout: REDIS_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
  }),
);

export const closeActionAdmissionRedis = () => admissionRedis.close();

export class ActionAdmissionError extends TaggedError("ActionAdmissionError")<{
  message: string;
  reason: "busy" | "unavailable";
  cause?: unknown;
}> {}

export type ActionAdmissionPolicy = {
  organizationConcurrency: number;
  userConcurrency: number;
  leaseMs: number;
};

// Both keys share the organization hash slot. The operation admits to both
// pools atomically, then expires even if the process dies before release.
// Redis supplies time so clocks on separate API hosts cannot expire one
// another's live leases.
const ACQUIRE_SCRIPT = `
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[2]) or redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[3]) then
  return 0
end
${ACTION_PERIOD_ACQUIRE_SCRIPT}
redis.call("ZADD", KEYS[1], now + tonumber(ARGV[1]), ARGV[4])
redis.call("ZADD", KEYS[2], now + tonumber(ARGV[1]), ARGV[4])
redis.call("PEXPIRE", KEYS[1], ARGV[1])
redis.call("PEXPIRE", KEYS[2], ARGV[1])
return 1
`;

const RENEW_SCRIPT = `
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
local orgExpiry = redis.call("ZSCORE", KEYS[1], ARGV[1])
local userExpiry = redis.call("ZSCORE", KEYS[2], ARGV[1])
if orgExpiry == false or userExpiry == false or tonumber(orgExpiry) <= now or tonumber(userExpiry) <= now then
  return 0
end
redis.call("ZADD", KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call("ZADD", KEYS[2], now + tonumber(ARGV[2]), ARGV[1])
redis.call("PEXPIRE", KEYS[1], ARGV[2])
redis.call("PEXPIRE", KEYS[2], ARGV[2])
return 1
`;

const RELEASE_SCRIPT = `
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
return 1
`;

type AdmissionKeys = {
  organization: CoordinationKey;
  user: CoordinationKey;
};

const admissionKeys = ({
  organizationId,
  userId,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}): AdmissionKeys => ({
  organization: coordinationKey({
    scope: "action-admission",
    slot: organizationId,
    suffix: "organization",
  }),
  user: coordinationKey({
    scope: "action-admission",
    slot: organizationId,
    suffix: `user:${userId}`,
  }),
});

const configuredPolicy = (): Result<
  ActionAdmissionPolicy,
  ActionAdmissionError
> => {
  const organizationConcurrency = env.ACTION_ADMISSION_ORG_CONCURRENCY;
  const userConcurrency = env.ACTION_ADMISSION_USER_CONCURRENCY;
  const leaseMs = env.ACTION_ADMISSION_LEASE_MS;
  if (
    organizationConcurrency === undefined ||
    userConcurrency === undefined ||
    leaseMs === undefined
  ) {
    return Result.err(
      new ActionAdmissionError({
        message: "Action admission configuration is incomplete",
        reason: "unavailable",
      }),
    );
  }
  return Result.ok({ organizationConcurrency, userConcurrency, leaseMs });
};

type ActionAdmissionOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  run: (signal: AbortSignal) => Promise<unknown>;
  enabled?: boolean;
  policy?: ActionAdmissionPolicy;
  periodIdentity?: ActionPeriodIdentity;
  periodPolicy?: ActionPeriodPolicy;
  redis?: RedisCommands;
  redisReady?: () => Promise<RedisCommands>;
  createId?: () => string;
  timing?: AdmissionTiming;
};

type AdmissionTiming = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
};

type AdmissionScope = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  signal: AbortSignal;
  status: "active" | "settled";
};

const admissionScope = new AsyncLocalStorage<AdmissionScope>();

const defaultTiming: AdmissionTiming = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

type AdmissionExecutorOptions = {
  keys: AdmissionKeys;
  budget: ActionPeriodBudget | null;
  organizationId: SafeId<"organization">;
  periodIdentity: ActionPeriodIdentity | undefined;
  redis: RedisCommands | undefined;
  redisReady: () => Promise<RedisCommands>;
};

const createAdmissionExecutor = ({
  keys,
  budget,
  organizationId,
  periodIdentity,
  redis,
  redisReady,
}: AdmissionExecutorOptions) => {
  const retryIdentity =
    periodIdentity === undefined
      ? undefined
      : {
          actionKind: periodIdentity.actionKind,
          logicalPhaseId: periodIdentity.logicalPhaseId,
        };
  const execute = async (script: string, args: string[]) =>
    await Result.tryPromise({
      try: async () => {
        const client: RedisCommands =
          redis ??
          (await withCommandTimeout({
            command: redisReady(),
            commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
            label: "action-admission-redis-connect",
          }));
        const send = async (
          window: ActionPeriodBudget | null,
          commandArgs: string[],
        ) => {
          // Renewal and release touch concurrency keys alone.
          const scriptKeys =
            script === ACQUIRE_SCRIPT && window !== null
              ? [keys.organization, keys.user, window.key]
              : [keys.organization, keys.user];
          return await withCommandTimeout({
            command: client.send("EVAL", [
              script,
              String(scriptKeys.length),
              ...scriptKeys,
              ...commandArgs,
            ]),
            commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
            label: "action-admission-redis-command",
          });
        };
        const reply = await send(budget, args);
        const storeNow =
          script === ACQUIRE_SCRIPT ? staleActionPeriodTime(reply) : null;
        if (budget === null || storeNow === null) {
          return reply;
        }

        // A stale window has not reserved anything. Retry once using store time,
        // with the original lease and logical phase, never after another failure.
        const refreshed = resolveActionPeriodBudget({
          organizationId,
          identity: retryIdentity,
          policy: {
            periodMs: budget.endMs - budget.startMs,
            limit: budget.limit,
          },
          nowMs: storeNow,
        });
        if (Result.isError(refreshed)) {
          throw refreshed.error;
        }
        if (refreshed.value === null) {
          return -2;
        }
        return await send(refreshed.value, [
          ...args.slice(0, 4),
          ...actionPeriodArguments(refreshed.value),
        ]);
      },
      catch: (error: unknown) =>
        new ActionAdmissionError({
          message: "Action admission is unavailable",
          reason: "unavailable",
          cause: error,
        }),
    });

  return execute;
};

/**
 * The disabled branch never opens Valkey or reads admission configuration.
 * Nested admission must be awaited: same-caller work shares the parent's lease
 * and signal only until that parent settles. Detached execution needs a fresh scope.
 */
export const withActionAdmission = async <T>({
  organizationId,
  userId,
  run,
  enabled = env.FEATURE_ACTION_ADMISSION,
  policy,
  periodIdentity,
  periodPolicy,
  redis,
  redisReady = admissionRedis.ready,
  createId = () => Bun.randomUUIDv7(),
  timing = defaultTiming,
}: Omit<ActionAdmissionOptions, "run"> & {
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<Result<T, unknown>> => {
  if (!enabled) {
    return await Result.tryPromise({
      try: async () => await run(new AbortController().signal),
      catch: (error: unknown) => error,
    });
  }

  const resolvedBudget = resolveActionPeriodBudget({
    organizationId,
    identity: periodIdentity,
    policy: periodPolicy,
    nowMs: Temporal.Now.instant().epochMilliseconds,
  });
  if (Result.isError(resolvedBudget)) {
    return Result.err(
      new ActionAdmissionError({
        message: resolvedBudget.error.message,
        reason: "unavailable",
        cause: resolvedBudget.error,
      }),
    );
  }
  const budget = resolvedBudget.value;

  const inherited = admissionScope.getStore();
  if (
    inherited?.status === "active" &&
    inherited.organizationId === organizationId &&
    inherited.userId === userId
  ) {
    return await Result.tryPromise({
      try: async () => {
        inherited.signal.throwIfAborted();
        const value = await run(inherited.signal);
        inherited.signal.throwIfAborted();
        return value;
      },
      catch: (error: unknown) => error,
    });
  }

  const resolvedPolicy =
    policy === undefined ? configuredPolicy() : Result.ok(policy);
  if (Result.isError(resolvedPolicy)) {
    return resolvedPolicy;
  }
  const limits = resolvedPolicy.value;
  const keys = admissionKeys({ organizationId, userId });
  const leaseId = createId();
  const periodArgs = actionPeriodArguments(budget);
  const execute = createAdmissionExecutor({
    keys,
    budget,
    organizationId,
    periodIdentity,
    redis,
    redisReady,
  });

  const initialAttemptAt = timing.now();
  const admitted = await execute(ACQUIRE_SCRIPT, [
    String(limits.leaseMs),
    String(limits.organizationConcurrency),
    String(limits.userConcurrency),
    leaseId,
    ...periodArgs,
  ]);
  if (Result.isError(admitted)) {
    return admitted;
  }
  if (admitted.value === 0 || admitted.value === -1) {
    return Result.err(
      new ActionAdmissionError({
        message:
          admitted.value === -1
            ? "Action period limit reached"
            : "Concurrent action limit reached",
        reason: "busy",
      }),
    );
  }
  if (admitted.value !== 1) {
    return Result.err(
      new ActionAdmissionError({
        message: "Action admission returned an invalid response",
        reason: "unavailable",
      }),
    );
  }

  let leaseDeadline = initialAttemptAt + limits.leaseMs;
  const controller = new AbortController();
  let leaseLost: ActionAdmissionError | null = null;
  let stopped = false;
  let cancelScheduled: () => void = () => undefined;
  let renewal: Promise<void> | null = null;

  const loseLease = () => {
    if (stopped || leaseLost !== null) {
      return;
    }
    leaseLost = new ActionAdmissionError({
      message: "Action lease was lost",
      reason: "unavailable",
    });
    cancelScheduled();
    controller.abort(leaseLost);
  };

  const scheduleRenewal = (delayMs: number) => {
    if (!stopped && leaseLost === null) {
      cancelScheduled = timing.schedule(() => {
        renewal = renew()
          .catch((error: unknown) => {
            observeFailure(error, { sink: RENEW_FAILURE });
            loseLease();
          })
          .finally(() => {
            renewal = null;
          });
      }, delayMs);
    }
  };

  const renew = async () => {
    const attemptAt = timing.now();
    if (attemptAt >= leaseDeadline) {
      loseLease();
      return;
    }
    const result = await execute(RENEW_SCRIPT, [
      leaseId,
      String(limits.leaseMs),
    ]);
    if (Result.isOk(result)) {
      if (result.value !== 1) {
        loseLease();
        return;
      }
      leaseDeadline = attemptAt + limits.leaseMs;
      scheduleRenewal(Math.max(1, Math.floor(limits.leaseMs / 2)));
      return;
    }
    observeFailure(result.error, { sink: RENEW_FAILURE });
    const remaining = leaseDeadline - timing.now();
    if (remaining <= 0) {
      loseLease();
      return;
    }
    scheduleRenewal(
      Math.max(1, Math.min(Math.floor(limits.leaseMs / 4), remaining)),
    );
  };

  if (timing.now() >= leaseDeadline) {
    loseLease();
  } else {
    scheduleRenewal(Math.max(1, Math.floor(limits.leaseMs / 2)));
  }

  let outcome: Result<T, unknown>;
  const scope: AdmissionScope = {
    organizationId,
    userId,
    signal: controller.signal,
    status: "active",
  };
  try {
    outcome = await Result.tryPromise({
      try: async () =>
        await admissionScope.run(scope, async () => {
          controller.signal.throwIfAborted();
          return await run(controller.signal);
        }),
      catch: (error: unknown) => error,
    });
  } finally {
    scope.status = "settled";
    stopped = true;
    cancelScheduled();
    await Promise.resolve(renewal);
    const released = await execute(RELEASE_SCRIPT, [leaseId]);
    if (Result.isError(released)) {
      // The lease expires on its own. A release outage must not make a
      // completed action look retryable and invite duplicate side effects.
      observeFailure(released.error, { sink: RELEASE_FAILURE });
    }
  }
  if (controller.signal.aborted) {
    return Result.err(controller.signal.reason);
  }
  return outcome;
};
