import { Result, TaggedError } from "better-result";
import type { Context, Options } from "elysia-rate-limit";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { createRedisClient } from "@/api/lib/redis-client";

const REDIS_KEY_PREFIX = "api:ratelimit:v1:";
const REDIS_COMMAND_TIMEOUT_MS = 500;
const FAIL_CLOSED_COUNT = Number.MAX_SAFE_INTEGER;

const INCREMENT_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if current == 1 or ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

const DECREMENT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if current <= 0 then
  return 0
end
return redis.call("DECR", KEYS[1])
`;

const REDIS_RATE_LIMIT_FAILURE_POLICIES = [
  "fail_open_local",
  "fail_closed",
] as const;
type RedisRateLimitFailurePolicy =
  (typeof REDIS_RATE_LIMIT_FAILURE_POLICIES)[number];

type RedisRateLimitClient = {
  close?: () => void;
  send: (command: string, args: string[]) => Promise<unknown>;
};

type ScheduleTimeout = (callback: () => void, delayMs: number) => () => void;
type RedisRateLimitOperation = "decrement" | "increment" | "reset";

type RedisRateLimitContextOptions = {
  commandTimeoutMs?: number;
  createRedis?: () => RedisRateLimitClient;
  failurePolicy: RedisRateLimitFailurePolicy;
  onRedisError?: (error: unknown, operation: RedisRateLimitOperation) => void;
  scheduleTimeout?: ScheduleTimeout;
};

type RateLimitCounter = {
  count: number;
  nextReset: Date;
  start: number;
};

class RedisRateLimitReplyError extends TaggedError("RedisRateLimitReplyError")<{
  message: string;
  reply: unknown;
}>() {}

/** Replica-safe fixed-window context with a bounded, explicit outage policy. */
export class RedisRateLimitContext implements Context {
  private readonly commandTimeoutMs: number;
  private readonly createRedis: () => RedisRateLimitClient;
  private readonly failurePolicy: RedisRateLimitFailurePolicy;
  private readonly fallback = new InMemoryRateLimitContext();
  private readonly onRedisError: (
    error: unknown,
    operation: RedisRateLimitOperation,
  ) => void;
  private readonly scheduleTimeout: ScheduleTimeout;
  private durationMs = 60_000;
  private redis: RedisRateLimitClient | null = null;
  private redisRefundsSuppressedUntil = 0;

  constructor({
    commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS,
    createRedis = () =>
      createRedisClient({
        connectionTimeout: commandTimeoutMs,
        enableOfflineQueue: false,
      }),
    failurePolicy,
    onRedisError,
    scheduleTimeout = defaultScheduleTimeout,
  }: RedisRateLimitContextOptions) {
    this.commandTimeoutMs = commandTimeoutMs;
    this.createRedis = createRedis;
    this.failurePolicy = failurePolicy;
    this.onRedisError =
      onRedisError ??
      ((error, operation) => {
        logger.warn("api.rate_limit.redis_failed", {
          "error.type": errorTag(error),
          failurePolicy,
          operation,
        });
      });
    this.scheduleTimeout = scheduleTimeout;
  }

  init(options: Omit<Options, "context">): void {
    if (typeof options.duration === "number") {
      this.durationMs = options.duration;
    }
    this.fallback.init(options);
  }

  async increment(
    key: string,
    duration?: number,
    requestTime?: number,
  ): Promise<RateLimitCounter> {
    const effectiveDuration = duration ?? this.durationMs;
    const now = requestTime ?? Date.now();
    const fallbackCounter = this.fallback.increment(
      key,
      effectiveDuration,
      now,
    );
    const redisResult = await Result.tryPromise(async () => {
      const reply = await this.sendCommand("EVAL", [
        INCREMENT_SCRIPT,
        "1",
        redisRateLimitKey(key),
        String(effectiveDuration),
      ]);
      return parseIncrementReply(reply, effectiveDuration, now);
    });
    if (Result.isError(redisResult)) {
      this.onRedisError(redisResult.error, "increment");
      // Context.decrement has no increment token. Suppress shared refunds after any
      // fallback rather than risk refunding another replica's successful request.
      this.redisRefundsSuppressedUntil = Math.max(
        this.redisRefundsSuppressedUntil,
        Date.now() + effectiveDuration,
      );
      if (this.failurePolicy === "fail_open_local") {
        return fallbackCounter;
      }
      return {
        count: FAIL_CLOSED_COUNT,
        nextReset: new Date(now + effectiveDuration),
        start: now,
      };
    }
    return redisResult.value;
  }

  async decrement(key: string): Promise<void> {
    this.fallback.decrement(key);
    if (this.redisRefundsSuppressedUntil > Date.now()) {
      return;
    }
    const result = await Result.tryPromise(
      async () =>
        await this.sendCommand("EVAL", [
          DECREMENT_SCRIPT,
          "1",
          redisRateLimitKey(key),
        ]),
    );
    if (Result.isError(result)) {
      this.onRedisError(result.error, "decrement");
    }
  }

  async reset(key?: string): Promise<void> {
    this.fallback.reset(key);
    // Never scan/delete the shared namespace; TTL expiry owns global cleanup.
    if (key === undefined) {
      this.redisRefundsSuppressedUntil = 0;
      return;
    }
    const result = await Result.tryPromise(
      async () => await this.sendCommand("DEL", [redisRateLimitKey(key)]),
    );
    if (Result.isError(result)) {
      this.onRedisError(result.error, "reset");
    }
  }

  kill(): void {
    this.fallback.kill();
    this.redisRefundsSuppressedUntil = 0;
    this.redis?.close?.();
    this.redis = null;
  }

  private async sendCommand(command: string, args: string[]): Promise<unknown> {
    this.redis ??= this.createRedis();
    const redis = this.redis;
    const result = await Result.tryPromise(
      async () =>
        await withCommandTimeout({
          command: redis.send(command, args),
          commandTimeoutMs: this.commandTimeoutMs,
          scheduleTimeout: this.scheduleTimeout,
        }),
    );
    if (Result.isError(result)) {
      if (TimeoutError.is(result.error)) {
        redis.close?.();
        if (this.redis === redis) {
          this.redis = null;
        }
      }
      throw result.error;
    }
    return result.value;
  }
}

const redisRateLimitKey = (key: string): string => `${REDIS_KEY_PREFIX}${key}`;

const parseIncrementReply = (
  reply: unknown,
  durationMs: number,
  now: number,
): RateLimitCounter => {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new RedisRateLimitReplyError({
      message: "Redis returned an invalid rate-limit counter reply",
      reply,
    });
  }
  const count = Number(reply.at(0));
  const ttlMs = Number(reply.at(1));
  if (
    !Number.isFinite(count) ||
    !Number.isFinite(ttlMs) ||
    count < 1 ||
    ttlMs < 0
  ) {
    throw new RedisRateLimitReplyError({
      message: "Redis returned invalid rate-limit counter values",
      reply,
    });
  }
  const nextReset = new Date(now + ttlMs);
  return {
    count,
    nextReset,
    start: nextReset.getTime() - durationMs,
  };
};

const defaultScheduleTimeout: ScheduleTimeout = (callback, delayMs) => {
  const timeoutId = setTimeout(callback, delayMs);
  return () => clearTimeout(timeoutId);
};

type WithCommandTimeoutOptions<T> = {
  command: Promise<T>;
  commandTimeoutMs: number;
  scheduleTimeout: ScheduleTimeout;
};

const withCommandTimeout = async <T>({
  command,
  commandTimeoutMs,
  scheduleTimeout,
}: WithCommandTimeoutOptions<T>): Promise<T> => {
  let cancelTimeout: () => void = () => undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    cancelTimeout = scheduleTimeout(
      () =>
        reject(
          new TimeoutError({
            label: "api-rate-limit-redis-command",
            message: "Redis rate-limit command timed out",
            timeoutMs: commandTimeoutMs,
          }),
        ),
      commandTimeoutMs,
    );
  });
  return await Promise.race([command, timeout]).finally(cancelTimeout);
};
