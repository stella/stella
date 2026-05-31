/**
 * Redis-backed storage for better-auth's rate limiter.
 *
 * Auth rate-limit counters (OTP send/verify, sign-in, sign-up, password
 * reset) must be global across API replicas. A per-process counter lets
 * a client get up to N× the configured limit with N instances, which
 * weakens brute-force / OTP-guessing protection.
 *
 * Fail-open: if Redis is unreachable the storage degrades to a
 * per-process Map (the previous behaviour) instead of blocking auth. A
 * Redis outage must never hard-lock sign-in.
 */
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createRedisClient } from "@/api/lib/redis-client";

type RateLimitValue = {
  key: string;
  count: number;
  lastRequest: number;
};

type AuthRateLimitStorage = {
  get: (key: string) => Promise<RateLimitValue | null>;
  set: (key: string, value: RateLimitValue) => Promise<void>;
};

const REDIS_KEY_PREFIX = "auth:ratelimit:";
const FALLBACK_CLEANUP_INTERVAL_MS = 60_000;
/**
 * Bound every Redis command so a slow or unreachable Redis cannot stall
 * an auth request. Bun's RedisClient has no built-in commandTimeout, so
 * we race the command against a timer and degrade to the fallback Map
 * if it does not resolve in time.
 */
const COMMAND_TIMEOUT_MS = 500;

const isRateLimitValue = (value: unknown): value is RateLimitValue =>
  typeof value === "object" &&
  value !== null &&
  "key" in value &&
  "count" in value &&
  "lastRequest" in value &&
  typeof value.key === "string" &&
  typeof value.count === "number" &&
  typeof value.lastRequest === "number";

const isStricterRateLimitValue = (
  candidate: RateLimitValue,
  current: RateLimitValue,
): boolean =>
  candidate.count > current.count ||
  (candidate.count === current.count &&
    candidate.lastRequest > current.lastRequest);

const withCommandTimeout = async <T>(promise: Promise<T>): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("redis command timeout")),
      COMMAND_TIMEOUT_MS,
    );
  });
  return await Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
};

/**
 * Build the better-auth rate-limit storage. `ttlMs` is the longest
 * rate-limit window; it expires both Redis keys and fallback entries.
 */
export const createAuthRateLimitStorage = (
  ttlMs: number,
): AuthRateLimitStorage => {
  const redis = createRedisClient({
    connectionTimeout: COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
  });
  // Bun's RedisClient surfaces connection loss via the onclose callback
  // and exposes errors through rejected commands. Leaving onclose unset
  // is safe; per-command rejections drive the fail-open path below.

  type FallbackEntry = { value: RateLimitValue; expiresAt: number };
  const fallback = new Map<string, FallbackEntry>();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of fallback) {
      if (entry.expiresAt <= now) {
        fallback.delete(key);
      }
    }
  }, FALLBACK_CLEANUP_INTERVAL_MS);
  cleanup.unref();

  const readFallback = (key: string): RateLimitValue | null => {
    const entry = fallback.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      return null;
    }
    return { ...entry.value };
  };

  const writeRedis = async (key: string, value: RateLimitValue) => {
    await withCommandTimeout(
      redis.set(
        `${REDIS_KEY_PREFIX}${key}`,
        JSON.stringify(value),
        "PX",
        ttlMs,
      ),
    );
  };

  return {
    get: async (key) => {
      try {
        const fallbackValue = readFallback(key);
        const raw = await withCommandTimeout(
          redis.get(`${REDIS_KEY_PREFIX}${key}`),
        );
        if (raw === null) {
          return fallbackValue;
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isRateLimitValue(parsed)) {
          return fallbackValue;
        }
        const redisValue = { ...parsed };
        if (
          fallbackValue &&
          isStricterRateLimitValue(fallbackValue, redisValue)
        ) {
          try {
            await writeRedis(key, fallbackValue);
          } catch (error: unknown) {
            logger.warn("auth.rate_limit.redis_reconcile_failed", {
              "error.type": errorTag(error),
            });
          }
          return fallbackValue;
        }
        return redisValue;
      } catch (error: unknown) {
        logger.warn("auth.rate_limit.redis_get_failed", {
          "error.type": errorTag(error),
        });
        return readFallback(key);
      }
    },
    set: async (key, value) => {
      const snapshot = { ...value };
      // Keep the fallback warm so a later Redis outage still has data
      // from this instance to limit against.
      fallback.set(key, { value: snapshot, expiresAt: Date.now() + ttlMs });
      try {
        await writeRedis(key, snapshot);
      } catch (error: unknown) {
        logger.warn("auth.rate_limit.redis_set_failed", {
          "error.type": errorTag(error),
        });
      }
    },
  };
};
