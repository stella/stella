/**
 * Abuse guards for the public, unauthenticated feedback intake
 * (`POST /public/feedback`). This is an unauthenticated write endpoint, so it
 * needs bounding an attacker cannot escape by omitting a header.
 *
 * Two primitives, both Redis-backed with an in-memory fallback so a Redis blip
 * degrades to per-process limiting instead of failing open:
 *   - `consumeCounter`: fixed-window INCR+PEXPIRE counter (the intake's per-IP
 *     submission rate and the MCP tool's per-organization delivery rate both
 *     ride on this, keyed under distinct buckets);
 *   - `claimDedup` / `releaseDedup`: SETNX+PEXPIRE content dedup so an identical
 *     report submitted twice in the dedup window is rejected once, with a
 *     release path so a failed delivery does not block re-submission.
 *
 * Structure mirrors `mcp/gateway/rate-limit.ts` (same Redis client, same
 * command-timeout and fallback-cleanup discipline) rather than importing it:
 * that limiter is hardwired to the gateway's single window/max and key shape,
 * whereas the intake needs several independent windows.
 */

import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createRedisClient } from "@/api/lib/redis-client";

type RedisLike = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

type CounterEntry = { count: number; expiresAt: number };

const REDIS_KEY_PREFIX = "feedback:intake:";
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
  /** True when this content is seen for the first time in the window (claimed); false when it duplicates a live claim. */
  claimDedup: (input: { key: string; ttlMs: number }) => Promise<boolean>;
  /** Best-effort release of a prior claim so a failed delivery does not block re-submission. */
  releaseDedup: (input: { key: string }) => Promise<void>;
};

export const createFeedbackIntakeGuards = ({
  commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS,
  createRedis = () =>
    createRedisClient({
      connectionTimeout: commandTimeoutMs,
      enableOfflineQueue: false,
    }),
  now = Date.now,
  onRedisError = (error) => {
    logger.warn("feedback.intake.redis_failed", {
      "error.type": errorTag(error),
    });
  },
}: FeedbackIntakeGuardsOptions = {}): FeedbackIntakeGuards => {
  let redis: RedisLike | null = null;
  const counterFallback = new Map<string, CounterEntry>();
  const dedupFallback = new Map<string, number>();
  const counterCleanupState: FallbackCleanupState = { nextCleanupAt: 0 };
  const dedupCleanupState: FallbackCleanupState = { nextCleanupAt: 0 };

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
        key: `${REDIS_KEY_PREFIX}${scoped}`,
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

  const claimDedup: FeedbackIntakeGuards["claimDedup"] = async ({
    key,
    ttlMs,
  }) => {
    try {
      const reply = await withCommandTimeout(
        getRedis().send("SET", [
          `${REDIS_KEY_PREFIX}dedup:${key}`,
          "1",
          "NX",
          "PX",
          String(ttlMs),
        ]),
        commandTimeoutMs,
      );
      // Redis SET ... NX returns "OK" when it set the key, nil otherwise.
      return reply === "OK";
    } catch (error) {
      onRedisError(error);
      return claimDedupFallback({
        fallback: dedupFallback,
        key,
        now: now(),
        cleanupState: dedupCleanupState,
        ttlMs,
      });
    }
  };

  const releaseDedup: FeedbackIntakeGuards["releaseDedup"] = async ({
    key,
  }) => {
    try {
      await withCommandTimeout(
        getRedis().send("DEL", [`${REDIS_KEY_PREFIX}dedup:${key}`]),
        commandTimeoutMs,
      );
    } catch (error) {
      onRedisError(error);
      dedupFallback.delete(key);
    }
  };

  return { claimDedup, consumeCounter, releaseDedup };
};

const evalCounter = async ({
  commandTimeoutMs,
  key,
  redis,
  windowMs,
}: {
  commandTimeoutMs: number;
  key: string;
  redis: RedisLike;
  windowMs: number;
}): Promise<number> => {
  const rawCount = await withCommandTimeout(
    redis.send("EVAL", [CONSUME_SCRIPT, "1", key, String(windowMs)]),
    commandTimeoutMs,
  );
  const count = Number(rawCount);
  if (!Number.isFinite(count)) {
    throw new TypeError("Redis returned a non-numeric counter value");
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

const claimDedupFallback = ({
  cleanupState,
  fallback,
  key,
  now,
  ttlMs,
}: {
  cleanupState: FallbackCleanupState;
  fallback: Map<string, number>;
  key: string;
  now: number;
  ttlMs: number;
}): boolean => {
  const expiresAt = fallback.get(key);
  if (expiresAt !== undefined && expiresAt > now) {
    return false;
  }
  fallback.set(key, now + ttlMs);
  cleanupDedupFallback(fallback, now, cleanupState);
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

const cleanupDedupFallback = (
  fallback: Map<string, number>,
  now: number,
  state: FallbackCleanupState,
) => {
  if (fallback.size < FALLBACK_CLEANUP_THRESHOLD || now < state.nextCleanupAt) {
    return;
  }
  state.nextCleanupAt = now + FALLBACK_CLEANUP_INTERVAL_MS;
  for (const [key, expiresAt] of fallback) {
    if (expiresAt <= now) {
      fallback.delete(key);
    }
  }
};

const withCommandTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("redis command timeout")),
      timeoutMs,
    );
  });
  return await Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
};

export const feedbackIntakeGuards = createFeedbackIntakeGuards();
