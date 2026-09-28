import { TaggedError } from "better-result";

import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
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

const configuredPolicy = (): ActionAdmissionPolicy => {
  const organizationConcurrency = env.ACTION_ADMISSION_ORG_CONCURRENCY;
  const userConcurrency = env.ACTION_ADMISSION_USER_CONCURRENCY;
  const leaseMs = env.ACTION_ADMISSION_LEASE_MS;
  if (
    organizationConcurrency === undefined ||
    userConcurrency === undefined ||
    leaseMs === undefined
  ) {
    throw new ActionAdmissionError({
      message: "Action admission configuration is incomplete",
      reason: "unavailable",
    });
  }
  return { organizationConcurrency, userConcurrency, leaseMs };
};

type ActionAdmissionOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  run: (signal: AbortSignal) => Promise<unknown>;
  enabled?: boolean;
  policy?: ActionAdmissionPolicy;
  redis?: RedisCommands;
  redisReady?: () => Promise<RedisCommands>;
  createId?: () => string;
  timing?: AdmissionTiming;
};

type AdmissionTiming = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
};

const defaultTiming: AdmissionTiming = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** The disabled branch never opens Valkey or reads admission configuration. */
export const withActionAdmission = async <T>({
  organizationId,
  userId,
  run,
  enabled = env.FEATURE_ACTION_ADMISSION,
  policy,
  redis,
  redisReady = admissionRedis.ready,
  createId = () => Bun.randomUUIDv7(),
  timing = defaultTiming,
}: Omit<ActionAdmissionOptions, "run"> & {
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> => {
  if (!enabled) {
    return await run(new AbortController().signal);
  }

  const limits = policy ?? configuredPolicy();
  const keys = admissionKeys({ organizationId, userId });
  const leaseId = createId();
  const execute = async (script: string, args: string[]) => {
    try {
      const client: RedisCommands =
        redis ??
        (await withCommandTimeout({
          command: redisReady(),
          commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
          label: "action-admission-redis-connect",
        }));
      return await withCommandTimeout({
        command: client.send("EVAL", [
          script,
          "2",
          keys.organization,
          keys.user,
          ...args,
        ]),
        commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
        label: "action-admission-redis-command",
      });
    } catch (error) {
      throw new ActionAdmissionError({
        message: "Action admission is unavailable",
        reason: "unavailable",
        cause: error,
      });
    }
  };

  const initialAttemptAt = timing.now();
  const admitted = await execute(ACQUIRE_SCRIPT, [
    String(limits.leaseMs),
    String(limits.organizationConcurrency),
    String(limits.userConcurrency),
    leaseId,
  ]);
  if (admitted === 0) {
    throw new ActionAdmissionError({
      message: "Concurrent action limit reached",
      reason: "busy",
    });
  }
  if (admitted !== 1) {
    throw new ActionAdmissionError({
      message: "Action admission returned an invalid response",
      reason: "unavailable",
    });
  }

  let leaseDeadline = initialAttemptAt + limits.leaseMs;
  const controller = new AbortController();
  let leaseLost: ActionAdmissionError | null = null;
  let stopped = false;
  let cancelScheduled = () => undefined;
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
        renewal = renew().finally(() => {
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
    try {
      const result = await execute(RENEW_SCRIPT, [
        leaseId,
        String(limits.leaseMs),
      ]);
      if (result !== 1) {
        loseLease();
        return;
      }
      leaseDeadline = attemptAt + limits.leaseMs;
      scheduleRenewal(Math.max(1, Math.floor(limits.leaseMs / 2)));
    } catch (error) {
      captureError(error, { source: "action-admission", phase: "renew" });
      const remaining = leaseDeadline - timing.now();
      if (remaining <= 0) {
        loseLease();
        return;
      }
      scheduleRenewal(
        Math.max(1, Math.min(Math.floor(limits.leaseMs / 4), remaining)),
      );
    }
  };

  if (timing.now() >= leaseDeadline) {
    loseLease();
  } else {
    scheduleRenewal(Math.max(1, Math.floor(limits.leaseMs / 2)));
  }

  try {
    controller.signal.throwIfAborted();
    const result = await run(controller.signal);
    if (leaseLost !== null) {
      throw leaseLost;
    }
    return result;
  } catch (error) {
    if (leaseLost !== null) {
      throw leaseLost;
    }
    throw error;
  } finally {
    stopped = true;
    cancelScheduled();
    if (renewal !== null) {
      await renewal;
    }
    await execute(RELEASE_SCRIPT, [leaseId]).catch((error: unknown) => {
      // The lease expires on its own. A release outage must not make a
      // completed action look retryable and invite duplicate side effects.
      captureError(error, { source: "action-admission", phase: "release" });
    });
  }
};
