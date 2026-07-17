import { Result, TaggedError } from "better-result";
import type { Context, Generator, Options } from "elysia-rate-limit";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import { createRedisClient } from "@/api/lib/redis-client";

const REDIS_KEY_PREFIX = "api:ratelimit:v2:";
const REQUEST_KEY_SEPARATOR = "\u001f";
const REDIS_COMMAND_TIMEOUT_MS = 500;
const REFUND_PROVENANCE_CLEANUP_INTERVAL_MS = 60_000;
const FAIL_CLOSED_COUNT = Number.MAX_SAFE_INTEGER;

const INCREMENT_SCRIPT = `
local current = redis.call("HINCRBY", KEYS[1], "count", 1)
local ttl = redis.call("PTTL", KEYS[1])
if current == 1 or ttl < 0 then
  redis.call("HSET", KEYS[1], "window", ARGV[2])
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl, redis.call("HGET", KEYS[1], "window") }
`;

const DECREMENT_SCRIPT = `
if redis.call("HGET", KEYS[1], "window") ~= ARGV[1] then
  return tonumber(redis.call("HGET", KEYS[1], "count") or "0")
end
local current = tonumber(redis.call("HGET", KEYS[1], "count") or "0")
if current <= 0 then
  return 0
end
return redis.call("HINCRBY", KEYS[1], "count", -1)
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

type CreateRedisRateLimitOptions = {
  failurePolicy: RedisRateLimitFailurePolicy;
  scope: string;
};

type RedisRateLimitBinding = Pick<Options, "context" | "generator">;

type RateLimitCounter = {
  count: number;
  nextReset: Date;
  start: number;
};

type RedisIncrement = {
  counter: RateLimitCounter;
  windowId: string;
};

type RefundProvenance = {
  counterKey: string;
  expiresAt: number;
  windowId: string;
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
  private readonly refundProvenanceByRequest = new Map<
    string,
    RefundProvenance
  >();
  private readonly refundProvenanceCleanupTimer: ReturnType<typeof setInterval>;

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
    this.refundProvenanceCleanupTimer = setInterval(
      () => this.evictExpiredRefundProvenance(),
      REFUND_PROVENANCE_CLEANUP_INTERVAL_MS,
    );
    this.refundProvenanceCleanupTimer.unref();
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
    const { counterKey, requestId } = parseRequestScopedKey(key);
    const effectiveDuration = duration ?? this.durationMs;
    const now = requestTime ?? Date.now();
    const fallbackCounter = this.fallback.increment(
      counterKey,
      effectiveDuration,
      now,
    );
    const candidateWindowId = Bun.randomUUIDv7();
    const redisResult = await Result.tryPromise(async () => {
      const reply = await this.sendCommand("EVAL", [
        INCREMENT_SCRIPT,
        "1",
        redisRateLimitKey(counterKey),
        String(effectiveDuration),
        candidateWindowId,
      ]);
      return parseIncrementReply(reply, effectiveDuration, now);
    });
    if (Result.isError(redisResult)) {
      this.onRedisError(redisResult.error, "increment");
      if (requestId !== null) {
        this.refundProvenanceByRequest.delete(requestId);
      }
      if (this.failurePolicy === "fail_open_local") {
        return fallbackCounter;
      }
      return {
        count: FAIL_CLOSED_COUNT,
        nextReset: new Date(now + effectiveDuration),
        start: now,
      };
    }
    if (requestId !== null) {
      this.refundProvenanceByRequest.set(requestId, {
        counterKey,
        expiresAt: redisResult.value.counter.nextReset.getTime(),
        windowId: redisResult.value.windowId,
      });
    }
    return redisResult.value.counter;
  }

  async decrement(key: string): Promise<void> {
    const { counterKey, requestId } = parseRequestScopedKey(key);
    this.fallback.decrement(counterKey);
    if (requestId === null) {
      return;
    }
    const provenance = this.refundProvenanceByRequest.get(requestId);
    this.refundProvenanceByRequest.delete(requestId);
    if (provenance === undefined) {
      return;
    }
    const result = await Result.tryPromise(
      async () =>
        await this.sendCommand("EVAL", [
          DECREMENT_SCRIPT,
          "1",
          redisRateLimitKey(provenance.counterKey),
          provenance.windowId,
        ]),
    );
    if (Result.isError(result)) {
      this.onRedisError(result.error, "decrement");
    }
  }

  async reset(key?: string): Promise<void> {
    const counterKey =
      key === undefined ? undefined : parseRequestScopedKey(key).counterKey;
    this.fallback.reset(counterKey);
    // Never scan/delete the shared namespace; TTL expiry owns global cleanup.
    if (counterKey === undefined) {
      this.refundProvenanceByRequest.clear();
      return;
    }
    this.deleteRefundProvenanceForCounter(counterKey);
    const result = await Result.tryPromise(
      async () =>
        await this.sendCommand("DEL", [redisRateLimitKey(counterKey)]),
    );
    if (Result.isError(result)) {
      this.onRedisError(result.error, "reset");
    }
  }

  kill(): void {
    this.fallback.kill();
    clearInterval(this.refundProvenanceCleanupTimer);
    this.refundProvenanceByRequest.clear();
    this.redis?.close?.();
    this.redis = null;
  }

  private evictExpiredRefundProvenance(): void {
    const now = Date.now();
    for (const [requestId, provenance] of this.refundProvenanceByRequest) {
      if (provenance.expiresAt <= now) {
        this.refundProvenanceByRequest.delete(requestId);
      }
    }
  }

  private deleteRefundProvenanceForCounter(counterKey: string): void {
    for (const [requestId, provenance] of this.refundProvenanceByRequest) {
      if (provenance.counterKey === counterKey) {
        this.refundProvenanceByRequest.delete(requestId);
      }
    }
  }

  private async sendCommand(command: string, args: string[]): Promise<unknown> {
    this.redis ??= this.createRedis();
    const redis = this.redis;
    const result = await Result.tryPromise({
      try: async () =>
        await withCommandTimeout({
          command: redis.send(command, args),
          commandTimeoutMs: this.commandTimeoutMs,
          scheduleTimeout: this.scheduleTimeout,
        }),
      catch: (error: unknown) => error,
    });
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

type CreateRedisRateLimitRequestKeyOptions = {
  counterKey: string;
  requestId: string;
};

export const createRedisRateLimitRequestKey = ({
  counterKey,
  requestId,
}: CreateRedisRateLimitRequestKeyOptions): string =>
  `${counterKey}${REQUEST_KEY_SEPARATOR}${requestId}`;

type ParsedRequestScopedKey = {
  counterKey: string;
  requestId: string | null;
};

const parseRequestScopedKey = (key: string): ParsedRequestScopedKey => {
  const separatorIndex = key.lastIndexOf(REQUEST_KEY_SEPARATOR);
  if (separatorIndex === -1) {
    return { counterKey: key, requestId: null };
  }
  return {
    counterKey: key.slice(0, separatorIndex),
    requestId: key.slice(separatorIndex + REQUEST_KEY_SEPARATOR.length),
  };
};

const requestScopedGenerator = (scope: string): Generator => {
  const generateCounterKey = scopedGenerator(scope);
  const requestIds = new WeakMap<Request, string>();

  return async (request, server, derived) => {
    const counterKey = await generateCounterKey(request, server, derived);
    let requestId = requestIds.get(request);
    if (requestId === undefined) {
      requestId = Bun.randomUUIDv7();
      requestIds.set(request, requestId);
    }
    return createRedisRateLimitRequestKey({ counterKey, requestId });
  };
};

export const createRedisRateLimit = ({
  failurePolicy,
  scope,
}: CreateRedisRateLimitOptions): RedisRateLimitBinding => ({
  // Keep the context and request-token generator paired: the token lets a
  // failed request refund only the Redis window that admitted it.
  context: new RedisRateLimitContext({ failurePolicy }),
  generator: requestScopedGenerator(scope),
});

const redisRateLimitKey = (counterKey: string): string =>
  `${REDIS_KEY_PREFIX}${counterKey}`;

const parseIncrementReply = (
  reply: unknown,
  durationMs: number,
  now: number,
): RedisIncrement => {
  if (!Array.isArray(reply) || reply.length !== 3) {
    throw new RedisRateLimitReplyError({
      message: "Redis returned an invalid rate-limit counter reply",
      reply,
    });
  }
  const count = Number(reply.at(0));
  const ttlMs = Number(reply.at(1));
  const rawWindowId: unknown = reply.at(2);
  if (
    !Number.isFinite(count) ||
    !Number.isFinite(ttlMs) ||
    count < 1 ||
    ttlMs < 0 ||
    typeof rawWindowId !== "string" ||
    rawWindowId.length === 0
  ) {
    throw new RedisRateLimitReplyError({
      message: "Redis returned invalid rate-limit counter values",
      reply,
    });
  }
  const nextReset = new Date(now + ttlMs);
  return {
    counter: {
      count,
      nextReset,
      start: nextReset.getTime() - durationMs,
    },
    windowId: rawWindowId,
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
