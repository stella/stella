import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  createAdmissionRedis,
  resolveAdmissionRedisClient,
  sendAdmissionRedisCommand,
} from "@/api/lib/admission-redis";
import type {
  AdmissionRedisClient,
  AdmissionRedisReady,
} from "@/api/lib/admission-redis";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { CoordinationKey } from "@/api/lib/redis-keys";

import {
  ACTION_PERIOD_ACQUIRE_SCRIPT,
  ACTION_SERVICE_DEADLINE_SCRIPT,
} from "./action-period-budget";
import { withCommandTimeout } from "./redis-command-timeout";

const REDIS_COMMAND_TIMEOUT_MS = 500;
const RENEW_FAILURE = failureSink({
  event: "action_admission.renew_failed",
  expected: [],
});
const RELEASE_FAILURE = failureSink({
  event: "action_admission.release_failed",
  expected: [],
});
export const admissionRedis = createAdmissionRedis();

export type AdmissionTiming = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
};
export const defaultAdmissionTiming: AdmissionTiming = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

type AdmissionCommandOptions = {
  script: string;
  keys: CoordinationKey[];
  args: string[];
  redis?: AdmissionRedisClient | undefined;
  redisReady?: AdmissionRedisReady | undefined;
  commandTimeoutMs?: number;
};
export const executeAdmissionCommand = async ({
  script,
  keys,
  args,
  redis,
  redisReady = admissionRedis.ready,
  commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS,
}: AdmissionCommandOptions): Promise<Result<unknown, ActionAdmissionError>> => {
  const outcome = await Result.tryPromise({
    try: async () => {
      const connected =
        redis === undefined
          ? await withCommandTimeout({
              command: resolveAdmissionRedisClient(redisReady),
              commandTimeoutMs,
              label: "action-admission-redis-connect",
            })
          : Result.ok(redis);
      if (Result.isError(connected)) {
        return connected;
      }
      return await withCommandTimeout({
        command: sendAdmissionRedisCommand(connected.value, [
          script,
          String(keys.length),
          ...keys,
          ...args,
        ]),
        commandTimeoutMs,
        label: "action-admission-redis-command",
      });
    },
    catch: (error: unknown) => error,
  });
  const result = Result.isError(outcome) ? outcome : outcome.value;
  if (Result.isError(result)) {
    const cause = result.error;
    return Result.err(
      ActionAdmissionError.is(cause)
        ? cause
        : new ActionAdmissionError({
            message: "Action admission is unavailable",
            reason: "unavailable",
            cause,
          }),
    );
  }
  return Result.ok(result.value);
};

const busyReplySchema = v.tuple([
  v.literal(0),
  v.pipe(v.number(), v.integer(), v.minValue(1)),
]);
export const concurrencyBusyRefusal = (reply: unknown) =>
  v.is(busyReplySchema, reply)
    ? new ActionAdmissionError({
        message: "Concurrent action limit reached",
        reason: "busy",
        retryAfterMs: reply[1],
      })
    : null;

// Both keys share the organization hash slot. The operation admits to both
// pools atomically, then expires even if the process dies before release.
// Redis supplies time so clocks on separate API hosts cannot expire one
// another's live leases.
export const ACQUIRE_SCRIPT = `
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
${ACTION_SERVICE_DEADLINE_SCRIPT}
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[2]) or redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[3]) then
  local retry = 0
  for i = 1, 2 do
    local limit = tonumber(ARGV[i + 1])
    if redis.call("ZCARD", KEYS[i]) >= limit then
      local oldest = redis.call("ZRANGE", KEYS[i], 0, 0, "WITHSCORES")
      retry = math.max(retry, tonumber(oldest[2]) - now)
    end
  end
  return {0, math.max(1, retry)}
end
${ACTION_PERIOD_ACQUIRE_SCRIPT}
redis.call("ZADD", KEYS[1], now + tonumber(ARGV[1]), ARGV[4])
redis.call("ZADD", KEYS[2], now + tonumber(ARGV[1]), ARGV[4])
redis.call("PEXPIRE", KEYS[1], ARGV[1])
redis.call("PEXPIRE", KEYS[2], ARGV[1])
return 1
`;

export const RENEW_SCRIPT = `
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

export const RESERVE_PERIOD_SCRIPT = `
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
${ACTION_SERVICE_DEADLINE_SCRIPT}
local orgExpiry = redis.call("ZSCORE", KEYS[1], ARGV[4])
local userExpiry = redis.call("ZSCORE", KEYS[2], ARGV[4])
if orgExpiry == false or userExpiry == false or tonumber(orgExpiry) <= now or tonumber(userExpiry) <= now then
  return -2
end
${ACTION_PERIOD_ACQUIRE_SCRIPT}
return 1
`;

export const RELEASE_SCRIPT = `
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
return 1
`;

const settledAdmissionOutcome = <T>(
  outcome: Result<T, unknown>,
  signal: AbortSignal,
) => {
  // A settled success may already have committed or charged. Losing the lease
  // cannot replace it with an infrastructure error that invites duplicate work.
  if (
    Result.isError(outcome) &&
    signal.aborted &&
    (outcome.error === signal.reason ||
      (outcome.error instanceof Error && outcome.error.name === "AbortError"))
  ) {
    return Result.err(signal.reason);
  }
  return outcome;
};

export type LeaseDegradation = {
  phase: "renewal" | "release";
  reason: "unavailable" | "invalid_reply" | "lease_uncertain";
};

type LeaseAvailabilityPolicy =
  | { type: "required" }
  | {
      type: "best_effort";
      onDegraded: (event: LeaseDegradation) => void;
      onLost: () => void;
    };

type AcquiredConcurrencyLeaseOptions<T> = {
  availability: LeaseAvailabilityPolicy;
  leaseMs: number;
  leaseId: string;
  initialAttemptAt: number;
  timing: AdmissionTiming;
  execute: (
    script: string,
    args: string[],
  ) => Promise<Result<unknown, ActionAdmissionError>>;
  run: (signal: AbortSignal) => Promise<T>;
};

// Work must settle before release, including after cancellation or lease loss.
export const withAcquiredConcurrencyLease = async <T>({
  availability,
  leaseMs,
  leaseId,
  initialAttemptAt,
  timing,
  execute,
  run,
}: AcquiredConcurrencyLeaseOptions<T>): Promise<Result<T, unknown>> => {
  let leaseDeadline = initialAttemptAt + leaseMs;
  const controller = new AbortController();
  let leaseState: "active" | "degraded" | "lost" = "active";
  let stopped = false;
  let cancelScheduled: () => void = () => undefined;
  let renewal: Promise<void> | null = null;

  const loseLease = () => {
    if (leaseState !== "active") {
      return;
    }
    if (stopped) {
      if (availability.type === "best_effort") {
        leaseState = "lost";
        availability.onLost();
      }
      return;
    }
    const leaseLost = new ActionAdmissionError({
      message: "Action lease was lost",
      reason: "unavailable",
    });
    leaseState = "lost";
    cancelScheduled();
    if (availability.type === "best_effort") {
      availability.onLost();
    }
    controller.abort(leaseLost);
  };

  const degrade = (event: LeaseDegradation) => {
    if (leaseState !== "active") {
      return;
    }
    if (availability.type !== "best_effort") {
      panic("Required leases cannot degrade");
    }
    leaseState = "degraded";
    cancelScheduled();
    availability.onDegraded(event);
  };

  const deadline = () => {
    if (availability.type === "best_effort") {
      degrade({ phase: "renewal", reason: "lease_uncertain" });
      return;
    }
    loseLease();
  };

  const scheduleRenewal = (delayMs: number) => {
    if (!stopped && leaseState === "active") {
      cancelScheduled = timing.schedule(() => {
        renewal = Result.tryPromise({
          try: renew,
          catch: (error: unknown) => error,
        })
          .then((outcome) => {
            if (Result.isError(outcome)) {
              if (availability.type === "best_effort") {
                degrade({ phase: "renewal", reason: "unavailable" });
              } else {
                observeFailure(outcome.error, { sink: RENEW_FAILURE });
                loseLease();
              }
            }
            return undefined;
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
      deadline();
      return;
    }
    const result = await execute(RENEW_SCRIPT, [leaseId, String(leaseMs)]);
    if (Result.isOk(result)) {
      if (result.value === 0) {
        loseLease();
        return;
      }
      if (result.value !== 1) {
        if (availability.type === "best_effort") {
          degrade({ phase: "renewal", reason: "invalid_reply" });
        } else {
          loseLease();
        }
        return;
      }
      leaseDeadline = attemptAt + leaseMs;
      scheduleRenewal(Math.max(1, Math.floor(leaseMs / 2)));
      return;
    }
    if (availability.type === "best_effort") {
      degrade({ phase: "renewal", reason: "unavailable" });
      return;
    }
    observeFailure(result.error, { sink: RENEW_FAILURE });
    const remaining = leaseDeadline - timing.now();
    if (remaining <= 0) {
      loseLease();
      return;
    }
    scheduleRenewal(Math.max(1, Math.min(Math.floor(leaseMs / 4), remaining)));
  };

  if (timing.now() >= leaseDeadline) {
    deadline();
  } else {
    scheduleRenewal(Math.max(1, Math.floor(leaseMs / 2)));
  }

  let outcome: Result<T, unknown>;
  try {
    outcome = await Result.tryPromise({
      try: async () => await run(controller.signal),
      catch: (error: unknown) => error,
    });
  } finally {
    stopped = true;
    cancelScheduled();
    await Promise.resolve(renewal);
    const released = await execute(RELEASE_SCRIPT, [leaseId]);
    if (Result.isError(released)) {
      // The lease expires on its own. A release outage must not make a
      // completed action look retryable and invite duplicate side effects.
      if (availability.type === "best_effort") {
        availability.onDegraded({ phase: "release", reason: "unavailable" });
      } else {
        observeFailure(released.error, { sink: RELEASE_FAILURE });
      }
    } else if (released.value !== 1 && availability.type === "best_effort") {
      availability.onDegraded({ phase: "release", reason: "invalid_reply" });
    }
  }
  return settledAdmissionOutcome(outcome, controller.signal);
};
