import { TaggedError } from "better-result";

import { Temporal } from "@stll/time";

import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { MCP_RATE_LIMITS } from "@/api/lib/rate-limit/budget-config";
import { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey, type CoordinationKey } from "@/api/lib/redis-keys";

type RedisLike = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

type FallbackEntry = {
  count: number;
  expiresAt: number;
};

type FallbackCleanupState = {
  nextCleanupAt: number;
};

type McpGatewayRateLimiterOptions = {
  commandTimeoutMs?: number;
  createRedis?: () => RedisLike;
  now?: () => number;
  onRedisError?: (error: unknown) => void;
  recordRejection?: typeof recordBudgetRejection;
};

const REDIS_COMMAND_TIMEOUT_MS = 500;
const FALLBACK_CLEANUP_THRESHOLD = 10_000;
const FALLBACK_CLEANUP_INTERVAL_MS = 60_000;
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
      storeClass: "durable-coordination",
      overrides: {
        connectionTimeout: commandTimeoutMs,
        enableOfflineQueue: false,
      },
    }),
  now = () => Temporal.Now.instant().epochMilliseconds,
  recordRejection = recordBudgetRejection,
  onRedisError = (error) => {
    logger.warn("mcp.gateway.rate_limit.redis_failed", {
      "error.type": errorTag(error),
    });
  },
}: McpGatewayRateLimiterOptions = {}) => {
  let redis: RedisLike | null = null;
  const fallback = new Map<string, FallbackEntry>();
  const cleanupState: FallbackCleanupState = { nextCleanupAt: 0 };

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

    let allowed: boolean;
    try {
      const count = await consumeRedis({
        commandTimeoutMs,
        key: coordinationKey({
          scope: "mcp-gateway-ratelimit",
          slot: userId,
          suffix: connectorSlug,
        }),
        redis: getRedis(),
      });
      allowed = count <= MCP_RATE_LIMITS.gateway.max;
    } catch (error) {
      onRedisError(error);
      allowed = consumeFallback({
        cleanupState,
        fallback,
        key,
        now: now(),
      });
    }
    if (!allowed) {
      recordRejection({
        name: "mcp.gateway.user_client",
        keyKind: "client",
        windowMs: MCP_RATE_LIMITS.gateway.windowMs,
      });
    }
    return allowed;
  };

  return { consume };
};

class McpGatewayRedisReplyError extends TaggedError(
  "McpGatewayRedisReplyError",
)<{
  message: string;
  reply: unknown;
}> {}

const consumeRedis = async ({
  commandTimeoutMs,
  key,
  redis,
}: {
  commandTimeoutMs: number;
  key: CoordinationKey;
  redis: RedisLike;
}): Promise<number> => {
  const rawCount = await withCommandTimeout({
    command: redis.send("EVAL", [
      CONSUME_SCRIPT,
      "1",
      key,
      String(MCP_RATE_LIMITS.gateway.windowMs),
    ]),
    commandTimeoutMs,
    label: "mcp-gateway-redis-command",
  });
  const count = Number(rawCount);
  if (!Number.isFinite(count)) {
    throw new McpGatewayRedisReplyError({
      message: "Redis returned a non-numeric rate-limit count",
      reply: rawCount,
    });
  }
  return count;
};

const consumeFallback = ({
  cleanupState,
  fallback,
  key,
  now,
}: {
  cleanupState: FallbackCleanupState;
  fallback: Map<string, FallbackEntry>;
  key: string;
  now: number;
}): boolean => {
  const current = fallback.get(key);
  if (!current || current.expiresAt <= now) {
    fallback.set(key, {
      count: 1,
      expiresAt: now + MCP_RATE_LIMITS.gateway.windowMs,
    });
    cleanupFallbackIfNeeded(fallback, now, cleanupState);
    return true;
  }

  if (current.count >= MCP_RATE_LIMITS.gateway.max) {
    return false;
  }

  current.count += 1;
  return true;
};

// Throttled O(n) sweep: even once the map is past its threshold, only sweep
// expired entries at most once per interval so a Redis outage that inserts
// past 10k entries does not run a full scan on every single insert.
const cleanupFallbackIfNeeded = (
  fallback: Map<string, FallbackEntry>,
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

const gatewayRateLimiter = createMcpGatewayRateLimiter();

export const consumeMcpGatewayRateLimit = async (input: {
  connectorSlug: string;
  userId: string;
}): Promise<boolean> => await gatewayRateLimiter.consume(input);
