import { TaggedError } from "better-result";

import { Temporal } from "@stll/time";
/**
 * Abuse guards for the public, unauthenticated feedback intake
 * (`POST /public/feedback`). This is an unauthenticated write endpoint, so it
 * needs bounding an attacker cannot escape by omitting a header.
 *
 * One primitive, Redis-backed with an in-memory fallback so a Redis blip
 * degrades to per-process limiting instead of failing open: `consumeCounter`,
 * a fixed-window INCR+PEXPIRE counter. The intake's per-IP submission rate,
 * the MCP tool's per-organization rate and the web route's per-user rate all
 * ride on it under distinct buckets.
 *
 * Content deduplication is deliberately NOT here. It is a fingerprint lookup
 * against the stored reports (`handlers/feedback/submit.ts`), so a resend
 * answers with the original receipt instead of an error, and the window
 * survives a Redis restart.
 *
 * Structure mirrors `mcp/gateway/rate-limit.ts` (same Redis client, same
 * command-timeout and fallback-cleanup discipline) rather than importing it:
 * that limiter is hardwired to the gateway's single window/max and key shape,
 * whereas the intake needs several independent windows.
 */

import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey, type CoordinationKey } from "@/api/lib/redis-keys";

type RedisLike = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

type CounterEntry = { count: number; expiresAt: number };

// The limited subject (IP, organization, content digest) is the colocation
// unit; the bucket only separates the windows that ride on it. Each key is
// read and written alone, so slotting by subject spreads the keyspace.
const counterKey = ({ bucket, key }: { bucket: string; key: string }) =>
  coordinationKey({
    scope: "feedback-intake",
    slot: key,
    suffix: `counter:${bucket}`,
  });

const REDIS_COMMAND_TIMEOUT_MS = 500;
const FALLBACK_CLEANUP_THRESHOLD = 10_000;
const FALLBACK_CLEANUP_INTERVAL_MS = 60_000;

// INCR the counter and, only on the first increment of a window, set its
// expiry. A fixed window (not a sliding one): simple, and adequate for coarse
// abuse bounding where a small boundary burst is acceptable.
const CONSUME_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return current
`;

type FeedbackIntakeGuardsOptions = {
  commandTimeoutMs?: number;
  createRedis?: () => RedisLike;
  now?: () => number;
  onRedisError?: (error: unknown) => void;
};

type FallbackCleanupState = {
  nextCleanupAt: number;
};

export type FeedbackIntakeGuards = {
  /** True when the increment stays within `max`; false once the window is exhausted. */
  consumeCounter: (input: {
    bucket: string;
    key: string;
    windowMs: number;
    max: number;
  }) => Promise<boolean>;
};

export const createFeedbackIntakeGuards = ({
  commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS,
  createRedis = () =>
    createRedisClient({
      connectionTimeout: commandTimeoutMs,
      enableOfflineQueue: false,
    }),
  now = () => Temporal.Now.instant().epochMilliseconds,
  onRedisError = (error) => {
    logger.warn("feedback.intake.redis_failed", {
      "error.type": errorTag(error),
    });
  },
}: FeedbackIntakeGuardsOptions = {}): FeedbackIntakeGuards => {
  let redis: RedisLike | null = null;
  const counterFallback = new Map<string, CounterEntry>();
  const counterCleanupState: FallbackCleanupState = { nextCleanupAt: 0 };

  const getRedis = () => {
    redis ??= createRedis();
    return redis;
  };

  const consumeCounter: FeedbackIntakeGuards["consumeCounter"] = async ({
    bucket,
    key,
    max,
    windowMs,
  }) => {
    const scoped = `${bucket}:${key}`;
    try {
      const count = await evalCounter({
        commandTimeoutMs,
        key: counterKey({ bucket, key }),
        redis: getRedis(),
        windowMs,
      });
      return count <= max;
    } catch (error) {
      onRedisError(error);
      return consumeCounterFallback({
        fallback: counterFallback,
        key: scoped,
        max,
        now: now(),
        cleanupState: counterCleanupState,
        windowMs,
      });
    }
  };

  return { consumeCounter };
};

class FeedbackIntakeRedisReplyError extends TaggedError(
  "FeedbackIntakeRedisReplyError",
)<{
  message: string;
  reply: unknown;
}> {}

const evalCounter = async ({
  commandTimeoutMs,
  key,
  redis,
  windowMs,
}: {
  commandTimeoutMs: number;
  key: CoordinationKey;
  redis: RedisLike;
  windowMs: number;
}): Promise<number> => {
  const rawCount = await withCommandTimeout({
    command: redis.send("EVAL", [CONSUME_SCRIPT, "1", key, String(windowMs)]),
    commandTimeoutMs,
    label: "feedback-intake-redis-command",
  });
  const count = Number(rawCount);
  if (!Number.isFinite(count)) {
    throw new FeedbackIntakeRedisReplyError({
      message: "Redis returned a non-numeric counter value",
      reply: rawCount,
    });
  }
  return count;
};

const consumeCounterFallback = ({
  cleanupState,
  fallback,
  key,
  max,
  now,
  windowMs,
}: {
  cleanupState: FallbackCleanupState;
  fallback: Map<string, CounterEntry>;
  key: string;
  max: number;
  now: number;
  windowMs: number;
}): boolean => {
  const current = fallback.get(key);
  if (!current || current.expiresAt <= now) {
    fallback.set(key, { count: 1, expiresAt: now + windowMs });
    cleanupCounterFallback(fallback, now, cleanupState);
    return true;
  }
  if (current.count >= max) {
    return false;
  }
  current.count += 1;
  return true;
};

const cleanupCounterFallback = (
  fallback: Map<string, CounterEntry>,
  now: number,
  state: FallbackCleanupState,
) => {
  if (fallback.size < FALLBACK_CLEANUP_THRESHOLD || now < state.nextCleanupAt) {
    return;
  }
  state.nextCleanupAt = now + FALLBACK_CLEANUP_INTERVAL_MS;
  for (const [key, entry] of fallback) {
    if (entry.expiresAt <= now) {
      fallback.delete(key);
    }
  }
};

export const feedbackIntakeGuards = createFeedbackIntakeGuards();
