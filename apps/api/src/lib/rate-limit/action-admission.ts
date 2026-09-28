import { TaggedError } from "better-result";

import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey, type CoordinationKey } from "@/api/lib/redis-keys";

type RedisCommands = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

const REDIS_COMMAND_TIMEOUT_MS = 500;

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
if redis.call("ZSCORE", KEYS[1], ARGV[1]) == false or redis.call("ZSCORE", KEYS[2], ARGV[1]) == false then
  return 0
end
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
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
  run: () => Promise<unknown>;
  enabled?: boolean;
  policy?: ActionAdmissionPolicy;
  redis?: RedisCommands;
  createId?: () => string;
};

/** The disabled branch never opens Valkey or reads admission configuration. */
export const withActionAdmission = async <T>({
  organizationId,
  userId,
  run,
  enabled = env.FEATURE_ACTION_ADMISSION,
  policy,
  redis,
  createId = () => Bun.randomUUIDv7(),
}: Omit<ActionAdmissionOptions, "run"> & {
  run: () => Promise<T>;
}): Promise<T> => {
  if (!enabled) {
    return await run();
  }

  const limits = policy ?? configuredPolicy();
  const client: RedisCommands =
    redis ?? createRedisClient({ enableOfflineQueue: false });
  const keys = admissionKeys({ organizationId, userId });
  const leaseId = createId();
  const execute = async (script: string, args: string[]) => {
    try {
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

  let renewal: Promise<void> | null = null;
  const heartbeat = setInterval(
    () => {
      if (renewal !== null) {
        return;
      }
      renewal = (async () => {
        const renewed = await execute(RENEW_SCRIPT, [
          leaseId,
          String(limits.leaseMs),
        ]);
        if (renewed !== 1) {
          throw new ActionAdmissionError({
            message: "Action lease was lost",
            reason: "unavailable",
          });
        }
      })()
        .catch((error: unknown) => {
          clearInterval(heartbeat);
          captureError(error, { source: "action-admission", phase: "renew" });
        })
        .finally(() => {
          renewal = null;
        });
    },
    Math.max(1, Math.floor(limits.leaseMs / 2)),
  );
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
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
