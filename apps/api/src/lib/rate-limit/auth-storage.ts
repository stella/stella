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
import {
  type ScheduleTimeout,
  withCommandTimeout,
} from "@/api/lib/rate-limit/redis-command-timeout";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey, type CoordinationKey } from "@/api/lib/redis-keys";

type AuthRateLimitStorage = {
  consume: (
    key: string,
    rule: { max: number; window: number },
  ) => Promise<{ allowed: boolean; retryAfter: number | null }>;
};

// The typed client methods are outside the `send(command, args)` shape the
// `require-coordination-key` lint rule inspects, so the key position is held by
// the type instead: a hand-written string does not satisfy `CoordinationKey`.
// `expiryMode` is likewise non-optional, which is this path's TTL discipline.
type AuthRateLimitRedisClient = {
  send: (
    command: "EVAL",
    args: [string, "1", CoordinationKey, string, string],
  ) => Promise<unknown>;
};

type CommandTimer = {
  set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear: (timeoutId: ReturnType<typeof setTimeout>) => void;
};

type AuthRateLimitStorageOptions = {
  redis?: AuthRateLimitRedisClient;
  commandTimer?: CommandTimer;
};

const FALLBACK_CLEANUP_INTERVAL_MS = 60_000;
/**
 * Bound every Redis command so a slow or unreachable Redis cannot stall
 * an auth request. Bun's RedisClient has no built-in commandTimeout, so
 * we race the command against a timer and degrade to the fallback Map
 * if it does not resolve in time.
 */
const COMMAND_TIMEOUT_MS = 500;
const DEFAULT_COMMAND_TIMER: CommandTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (timeoutId) => clearTimeout(timeoutId),
};

// Fixed-window consume. INCR and first-write expiry execute in one Redis
// script, so concurrent replicas cannot all observe the same stale counter.
// The remaining TTL is returned with the decision for Better Auth's exact
// Retry-After response.
const CONSUME_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if current <= tonumber(ARGV[2]) then
  return {1, 0}
end
return {0, math.max(1, math.ceil(ttl / 1000))}
`;

// better-auth's key already identifies one limited client, so it is the
// colocation unit; each key is read and written alone.
const authRateLimitKey = (key: string) =>
  coordinationKey({ scope: "auth-ratelimit", slot: key });

const parseRedisDecision = (
  value: unknown,
): { allowed: boolean; retryAfter: number | null } | null => {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const allowed = Number(value.at(0));
  const retryAfter = Number(value.at(1));
  if (
    (allowed !== 0 && allowed !== 1) ||
    !Number.isSafeInteger(retryAfter) ||
    retryAfter < 0
  ) {
    return null;
  }
  return {
    allowed: allowed === 1,
    retryAfter: allowed === 1 ? null : Math.max(1, retryAfter),
  };
};

/**
 * Build Better Auth's atomic rate-limit storage. Redis is authoritative while
 * reachable. A synchronized per-process counter remains warm on every request
 * and becomes the fail-open fallback if Redis is unavailable.
 */
export const createAuthRateLimitStorage = (
  options: AuthRateLimitStorageOptions = {},
): AuthRateLimitStorage => {
  const redis: AuthRateLimitRedisClient =
    options.redis ??
    createRedisClient({
      connectionTimeout: COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
    });
  const commandTimer = options.commandTimer ?? DEFAULT_COMMAND_TIMER;
  const scheduleTimeout: ScheduleTimeout = (callback, delayMs) => {
    const timeoutId = commandTimer.set(callback, delayMs);
    return () => commandTimer.clear(timeoutId);
  };
  // Bun's RedisClient surfaces connection loss via the onclose callback
  // and exposes errors through rejected commands. Leaving onclose unset
  // is safe; per-command rejections drive the fail-open path below.

  type FallbackEntry = { count: number; expiresAt: number };
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

  const consumeFallback = (
    key: string,
    rule: { max: number; window: number },
  ): { allowed: boolean; retryAfter: number | null } => {
    const now = Date.now();
    const entry = fallback.get(key);
    if (!entry || entry.expiresAt <= now) {
      fallback.set(key, {
        count: 1,
        expiresAt: now + rule.window * 1000,
      });
      return { allowed: true, retryAfter: null };
    }
    entry.count += 1;
    return entry.count <= rule.max
      ? { allowed: true, retryAfter: null }
      : {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)),
        };
  };

  return {
    consume: async (key, rule) => {
      const fallbackDecision = consumeFallback(key, rule);
      try {
        const raw = await withCommandTimeout({
          command: redis.send("EVAL", [
            CONSUME_SCRIPT,
            "1",
            authRateLimitKey(key),
            String(rule.window * 1000),
            String(rule.max),
          ]),
          commandTimeoutMs: COMMAND_TIMEOUT_MS,
          label: "auth-rate-limit-redis-command",
          scheduleTimeout,
        });
        const decision = parseRedisDecision(raw);
        if (decision === null) {
          logger.warn("auth.rate_limit.redis_invalid_response");
          return fallbackDecision;
        }
        return decision;
      } catch (error: unknown) {
        logger.warn("auth.rate_limit.redis_consume_failed", {
          "error.type": errorTag(error),
        });
        return fallbackDecision;
      }
    },
  };
};
