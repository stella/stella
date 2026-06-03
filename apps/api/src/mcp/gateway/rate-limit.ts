import { errorTag } from "@/api/lib/errors/utils";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { createRedisClient } from "@/api/lib/redis-client";

type RedisLike = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

type FallbackEntry = {
  count: number;
  expiresAt: number;
};

type McpGatewayRateLimiterOptions = {
  commandTimeoutMs?: number;
  createRedis?: () => RedisLike;
  now?: () => number;
  onRedisError?: (error: unknown) => void;
};

const REDIS_KEY_PREFIX = "mcp:gateway:ratelimit:";
const REDIS_COMMAND_TIMEOUT_MS = 500;
const FALLBACK_CLEANUP_THRESHOLD = 10_000;
const CONSUME_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return current
`;

export const createMcpGatewayRateLimiter = ({
  commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS,
  createRedis = () =>
    createRedisClient({
      connectionTimeout: commandTimeoutMs,
      enableOfflineQueue: false,
    }),
  now = Date.now,
  onRedisError = (error) => {
    logger.warn("mcp.gateway.rate_limit.redis_failed", {
      "error.type": errorTag(error),
    });
  },
}: McpGatewayRateLimiterOptions = {}) => {
  let redis: RedisLike | null = null;
  const fallback = new Map<string, FallbackEntry>();

  const getRedis = () => {
    redis ??= createRedis();
    return redis;
  };

  const consume = async ({
    connectorSlug,
    userId,
  }: {
    connectorSlug: string;
    userId: string;
  }): Promise<boolean> => {
    const key = `${userId}:${connectorSlug}`;

    try {
      const count = await consumeRedis({
        commandTimeoutMs,
        key: `${REDIS_KEY_PREFIX}${key}`,
        redis: getRedis(),
      });
      return count <= LIMITS.mcpGatewayRateLimitMax;
    } catch (error) {
      onRedisError(error);
      return consumeFallback({
        fallback,
        key,
        now: now(),
      });
    }
  };

  return { consume };
};

const consumeRedis = async ({
  commandTimeoutMs,
  key,
  redis,
}: {
  commandTimeoutMs: number;
  key: string;
  redis: RedisLike;
}): Promise<number> => {
  const rawCount = await withCommandTimeout(
    redis.send("EVAL", [
      CONSUME_SCRIPT,
      "1",
      key,
      String(LIMITS.mcpGatewayRateLimitWindowMs),
    ]),
    commandTimeoutMs,
  );
  const count = Number(rawCount);
  if (!Number.isFinite(count)) {
    throw new TypeError("Redis returned a non-numeric rate-limit count");
  }
  return count;
};

const consumeFallback = ({
  fallback,
  key,
  now,
}: {
  fallback: Map<string, FallbackEntry>;
  key: string;
  now: number;
}): boolean => {
  const current = fallback.get(key);
  if (!current || current.expiresAt <= now) {
    fallback.set(key, {
      count: 1,
      expiresAt: now + LIMITS.mcpGatewayRateLimitWindowMs,
    });
    cleanupFallbackIfNeeded(fallback, now);
    return true;
  }

  if (current.count >= LIMITS.mcpGatewayRateLimitMax) {
    return false;
  }

  current.count += 1;
  return true;
};

const cleanupFallbackIfNeeded = (
  fallback: Map<string, FallbackEntry>,
  now: number,
) => {
  if (fallback.size < FALLBACK_CLEANUP_THRESHOLD) {
    return;
  }

  for (const [key, entry] of fallback) {
    if (entry.expiresAt <= now) {
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

const gatewayRateLimiter = createMcpGatewayRateLimiter();

export const consumeMcpGatewayRateLimit = async (input: {
  connectorSlug: string;
  userId: string;
}): Promise<boolean> => await gatewayRateLimiter.consume(input);
