import { Result, TaggedError } from "better-result";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";
import { Temporal } from "@stll/time";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import type {
  RateLimitContextConfig,
  RateLimitGenerator,
  RateLimitOptions,
  ReadableRateLimitContext,
} from "@/api/lib/rate-limit/contracts";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import {
  defaultScheduleTimeout,
  type ScheduleTimeout,
  withCommandTimeout,
} from "@/api/lib/rate-limit/redis-command-timeout";
import { LimiterStoreUnavailableError } from "@/api/lib/rate-limit/store-unavailable";
import { createRedisClient } from "@/api/lib/redis-client";
import { type CoordinationKey, coordinationKey } from "@/api/lib/redis-keys";
import { isUnknownArray } from "@/api/lib/type-guards";

const REQUEST_KEY_SEPARATOR = "\u001f";
const REDIS_COMMAND_TIMEOUT_MS = 500;
const REFUND_PROVENANCE_CLEANUP_INTERVAL_MS = 60_000;
const LOCAL_LIMIT_EXCEEDED_COUNT = Number.MAX_SAFE_INTEGER;

// Every increment attempt is tagged with a client-generated attempt id
// (ARGV[2]) that the script records for refundable attempts, independent of
// whether it started a fresh window. A later refund matches on that same
// attempt id (see DECREMENT_SCRIPT) rather than on the window as a whole,
// so the caller never needs to learn a server-assigned window id to issue
// a safe refund -- see the comment on RefundProvenance for why that
// matters when the increment's reply is lost to a client-side timeout.
const INCREMENT_SCRIPT = `
local current = redis.call("HINCRBY", KEYS[1], "count", 1)
local ttl = redis.call("PTTL", KEYS[1])
if current == 1 or ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if ARGV[2] ~= "" then
  redis.call("HSET", KEYS[1], "attempt:" .. ARGV[2], "1")
end
return { current, ttl }
`;

// Refunds only apply if this exact attempt id is still recorded on the
// key: a genuinely-lost increment (never reached Redis) leaves no marker
// and this safely no-ops instead of wrongly decrementing. An expired or
// recreated window also carries no marker for an old attempt id, so a
// late refund can never bleed into a different window's count.
const DECREMENT_SCRIPT = `
local attemptField = "attempt:" .. ARGV[1]
if redis.call("HGET", KEYS[1], attemptField) == false then
  return tonumber(redis.call("HGET", KEYS[1], "count") or "0")
end
redis.call("HDEL", KEYS[1], attemptField)
local current = tonumber(redis.call("HGET", KEYS[1], "count") or "0")
if current <= 0 then
  return 0
end
return redis.call("HINCRBY", KEYS[1], "count", -1)
`;

const READ_SCRIPT = `
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then return { 0, -1 } end
return { tonumber(redis.call("HGET", KEYS[1], "count") or "0"), ttl }
`;

const REDIS_RATE_LIMIT_FAILURE_POLICIES = [
  "fail_open_local",
  "fail_closed",
] as const;
type RedisRateLimitFailurePolicy =
  (typeof REDIS_RATE_LIMIT_FAILURE_POLICIES)[number];

type RedisRateLimitClient = {
  close?: () => void;
  /**
   * Opens the socket before the first command. The context awaits this promise
   * once because the client runs with the offline queue disabled; after it
   * settles successfully, later commands are sent without awaiting it again.
   */
  connect?: () => Promise<void>;
  send: (command: string, args: string[]) => Promise<unknown>;
};

type RedisRateLimitOperation =
  "connect" | "decrement" | "increment" | "read" | "reset" | "complete";

type RedisRateLimitContextOptions = {
  commandTimeoutMs?: number;
  createRedis?: () => RedisRateLimitClient;
  failurePolicy: RedisRateLimitFailurePolicy;
  localMax?: number;
  onLocalFallback?: () => void;
  onRedisError?: (error: unknown, operation: RedisRateLimitOperation) => void;
  scheduleTimeout?: ScheduleTimeout;
};

type CreateRedisRateLimitOptions = {
  counterKeyGenerator?: RateLimitGenerator;
  failurePolicy: RedisRateLimitFailurePolicy;
  localMax?: number;
  onLocalFallback?: () => void;
  scope: string;
};

type RedisRateLimitBinding = Pick<RateLimitOptions, "context" | "generator">;

type RedisConnection = {
  client: RedisRateLimitClient;
  ready: Promise<RedisConnectOutcome> | null;
};

type RedisConnectOutcome =
  { status: "connected" } | { error: unknown; status: "failed" };

type RateLimitCounter = {
  count: number;
  nextReset: Date;
  start: number;
};

type RefundProvenance = {
  counterKey: string;
  expiresAt: number;
  fallbackStart: number;
} & (
  | { type: "local" }
  | {
      type: "redis";
      /**
       * The attempt id sent with the increment EVAL, retained when its reply
       * times out. DECREMENT_SCRIPT refunds only a matching recorded attempt;
       * an unrecorded attempt leaves the counter unchanged.
       */
      attemptId: string;
    }
);

class RedisRateLimitReplyError extends TaggedError("RedisRateLimitReplyError")<{
  message: string;
  reply: unknown;
}> {}

/** Replica-safe fixed-window context with a bounded, explicit outage policy. */
export class RedisRateLimitContext implements ReadableRateLimitContext {
  private readonly commandTimeoutMs: number;
  private readonly createRedis: () => RedisRateLimitClient;
  private readonly failurePolicy: RedisRateLimitFailurePolicy;
  private readonly localMax: number | undefined;
  private readonly onLocalFallback: (() => void) | undefined;
  private readonly fallback = new InMemoryRateLimitContext();
  private readonly onRedisError: (
    error: unknown,
    operation: RedisRateLimitOperation,
  ) => void;
  private readonly scheduleTimeout: ScheduleTimeout;
  private durationMs = 60_000;
  private redisConnection: RedisConnection | null = null;
  private readonly refundProvenanceByRequest = new Map<
    string,
    RefundProvenance
  >();
  private readonly refundProvenanceCleanupTimer: ReturnType<typeof setInterval>;

  constructor({
    commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS,
    createRedis = () =>
      createRedisClient({
        storeClass: "durable-coordination",
        overrides: {
          connectionTimeout: commandTimeoutMs,
          enableOfflineQueue: false,
        },
      }),
    failurePolicy,
    localMax,
    onLocalFallback,
    onRedisError,
    scheduleTimeout = defaultScheduleTimeout,
  }: RedisRateLimitContextOptions) {
    this.commandTimeoutMs = commandTimeoutMs;
    this.localMax = localMax;
    this.onLocalFallback = onLocalFallback;
    this.createRedis = createRedis;
    this.failurePolicy = failurePolicy;
    this.onRedisError =
      onRedisError ??
      ((error, operation) => {
        // This sink only ever sees connection, timeout, and reply-shape
        // errors, so the message is safe to surface (see
        // connectionErrorFields); the key is `error.msg` to survive the
        // logger's attribute sanitizer.
        logger.warn("api.rate_limit.redis_failed", {
          ...connectionErrorFields(error),
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

  init(options: RateLimitContextConfig): void {
    this.durationMs = options.duration;
    this.fallback.init(options);
  }

  async read(key: string): Promise<RateLimitCounter | null> {
    const { counterKey } = parseRequestScopedKey(key);
    const now = Temporal.Now.instant().epochMilliseconds;
    const result = await Result.tryPromise({
      try: async () => {
        const reply = await this.sendCommand("EVAL", [
          READ_SCRIPT,
          "1",
          redisRateLimitKey(counterKey),
        ]);
        if (isUnknownArray(reply) && reply.length === 2) {
          const [count, ttlMs] = reply;
          if (count === 0 && ttlMs === -1) {
            return null;
          }
          if (
            count === 0 &&
            typeof ttlMs === "number" &&
            Number.isSafeInteger(ttlMs) &&
            ttlMs >= 0
          ) {
            const nextReset = new Date(now + ttlMs);
            return {
              count: 0,
              nextReset,
              start: nextReset.getTime() - this.durationMs,
            };
          }
        }
        return parseIncrementReply(reply, this.durationMs, now);
      },
      catch: (error: unknown) => error,
    });
    if (Result.isOk(result)) {
      return result.value;
    }
    if (this.failurePolicy === "fail_open_local") {
      this.onRedisError(result.error, "read");
      this.onLocalFallback?.();
      const counter = this.fallback.read(counterKey);
      return counter &&
        this.localMax !== undefined &&
        counter.count > this.localMax
        ? { ...counter, count: LOCAL_LIMIT_EXCEEDED_COUNT }
        : counter;
    }
    throw new LimiterStoreUnavailableError({
      message: LIMITER_STORE_UNAVAILABLE.message,
      operation: "read",
      cause: result.error,
    });
  }

  async increment(
    key: string,
    duration?: number,
    requestTime?: number,
  ): Promise<RateLimitCounter> {
    const { counterKey, requestId } = parseRequestScopedKey(key);
    const effectiveDuration = duration ?? this.durationMs;
    const now = requestTime ?? Temporal.Now.instant().epochMilliseconds;
    const fallbackCounter = this.fallback.increment(
      counterKey,
      effectiveDuration,
      now,
    );
    // Plain counters cannot refund: do not allocate an identity they cannot settle.
    const attemptId = requestId === null ? "" : Bun.randomUUIDv7();
    // Identity `catch` keeps the raw thrown error (e.g. TimeoutError)
    // instead of Result.tryPromise's default UnhandledException wrapping,
    // so the TimeoutError.is() check below can actually discriminate an
    // ambiguous client-side timeout from other Redis failures.
    const redisResult = await Result.tryPromise({
      try: async () => {
        const reply = await this.sendCommand("EVAL", [
          INCREMENT_SCRIPT,
          "1",
          redisRateLimitKey(counterKey),
          String(effectiveDuration),
          attemptId,
        ]);
        return parseIncrementReply(reply, effectiveDuration, now);
      },
      catch: (error: unknown) => error,
    });
    if (Result.isError(redisResult)) {
      if (this.failurePolicy === "fail_open_local") {
        this.onRedisError(redisResult.error, "increment");
      }
      if (requestId !== null) {
        if (TimeoutError.is(redisResult.error)) {
          // The client gave up waiting, but the EVAL may already have
          // reached and executed on Redis -- there is no way to tell from
          // here. Retain provenance keyed by the attempt id we sent (not
          // a window id, since we never received one) so a later
          // decrement() can still attempt a refund; DECREMENT_SCRIPT
          // resolves the ambiguity server-side.
          this.refundProvenanceByRequest.set(requestId, {
            type: "redis",
            attemptId,
            counterKey,
            expiresAt: now + effectiveDuration,
            fallbackStart: fallbackCounter.start,
          });
        } else {
          this.refundProvenanceByRequest.set(requestId, {
            type: "local",
            counterKey,
            expiresAt: fallbackCounter.nextReset.getTime(),
            fallbackStart: fallbackCounter.start,
          });
        }
      }
      if (this.failurePolicy === "fail_open_local") {
        this.onLocalFallback?.();
        if (
          this.localMax !== undefined &&
          fallbackCounter.count > this.localMax
        ) {
          return { ...fallbackCounter, count: LOCAL_LIMIT_EXCEEDED_COUNT };
        }
        return fallbackCounter;
      }
      throw new LimiterStoreUnavailableError({
        message: LIMITER_STORE_UNAVAILABLE.message,
        operation: "increment",
        cause: redisResult.error,
      });
    }
    if (requestId !== null) {
      this.refundProvenanceByRequest.set(requestId, {
        type: "redis",
        attemptId,
        counterKey,
        expiresAt: redisResult.value.nextReset.getTime(),
        fallbackStart: fallbackCounter.start,
      });
    }
    return redisResult.value;
  }

  async complete(key: string): Promise<void> {
    const { requestId } = parseRequestScopedKey(key);
    if (requestId === null) {
      return;
    }
    const provenance = this.refundProvenanceByRequest.get(requestId);
    this.refundProvenanceByRequest.delete(requestId);
    if (provenance === undefined || provenance.type === "local") {
      return;
    }
    // No handler refund can occur after the response is sent. The counter and
    // its expiry survive; long budgets retain only in-flight refund identities.
    const result = await Result.tryPromise(
      async () =>
        await this.sendCommand("HDEL", [
          redisRateLimitKey(provenance.counterKey),
          `attempt:${provenance.attemptId}`,
        ]),
    );
    if (Result.isError(result)) {
      this.onRedisError(result.error, "complete");
    }
  }

  async decrement(key: string, windowStart?: number): Promise<void> {
    const { counterKey, requestId } = parseRequestScopedKey(key);
    if (requestId === null) {
      this.fallback.decrement(counterKey, windowStart);
      return;
    }
    const provenance = this.refundProvenanceByRequest.get(requestId);
    this.refundProvenanceByRequest.delete(requestId);
    if (provenance === undefined) {
      return;
    }
    this.fallback.decrement(counterKey, provenance.fallbackStart);
    if (provenance.type === "local") {
      return;
    }
    const result = await Result.tryPromise(
      async () =>
        await this.sendCommand("EVAL", [
          DECREMENT_SCRIPT,
          "1",
          redisRateLimitKey(provenance.counterKey),
          provenance.attemptId,
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
    // Disown before closing: closing rejects a still-pending connect, and the
    // client may settle that promise within the close call itself, so the
    // handler must already see this client as replaced.
    const connection = this.redisConnection;
    this.redisConnection = null;
    connection?.client.close?.();
  }

  private evictExpiredRefundProvenance(): void {
    const now = Temporal.Now.instant().epochMilliseconds;
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

  private async getRedis() {
    let connection = this.redisConnection;
    if (connection === null) {
      const client = this.createRedis();
      const createdConnection: RedisConnection = { client, ready: null };
      connection = createdConnection;
      this.redisConnection = createdConnection;
      if (client.connect !== undefined) {
        createdConnection.ready = withCommandTimeout({
          command: Promise.resolve().then(async () => await client.connect?.()),
          commandTimeoutMs: this.commandTimeoutMs,
          label: "api-rate-limit-redis-connect",
          scheduleTimeout: this.scheduleTimeout,
        }).then(
          () => ({ status: "connected" }),
          (error: unknown) => ({ error, status: "failed" }),
        );
      }
    }
    if (connection.ready !== null) {
      const outcome = await connection.ready;
      if (this.redisConnection === connection) {
        connection.ready = null;
      }
      if (outcome.status === "failed") {
        return Result.err(outcome.error);
      }
    }
    return Result.ok(connection.client);
  }

  private async sendCommand(command: string, args: string[]): Promise<unknown> {
    const redisResult = await this.getRedis();
    const redis = Result.isOk(redisResult) ? redisResult.value : null;
    const result =
      redis === null
        ? redisResult
        : await Result.tryPromise({
            try: async () =>
              await withCommandTimeout({
                command: redis.send(command, args),
                commandTimeoutMs: this.commandTimeoutMs,
                label: "api-rate-limit-redis-command",
                scheduleTimeout: this.scheduleTimeout,
              }),
            catch: (error: unknown) => error,
          });
    if (Result.isError(result)) {
      if (redis !== null && TimeoutError.is(result.error)) {
        if (this.redisConnection?.client === redis) {
          this.redisConnection = null;
        }
        redis.close?.();
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

const requestScopedGenerator = (
  scope: string,
  counterKeyGenerator = scopedGenerator(scope),
): RateLimitGenerator => {
  const requestIds = new WeakMap<Request, string>();

  return async (request, server) => {
    const counterKey = await counterKeyGenerator(request, server);
    let requestId = requestIds.get(request);
    if (requestId === undefined) {
      requestId = Bun.randomUUIDv7();
      requestIds.set(request, requestId);
    }
    return createRedisRateLimitRequestKey({ counterKey, requestId });
  };
};

export const createRedisRateLimit = ({
  counterKeyGenerator,
  failurePolicy,
  localMax,
  onLocalFallback,
  scope,
}: CreateRedisRateLimitOptions): RedisRateLimitBinding => ({
  // Keep the context and request-token generator paired: the token lets a
  // failed request refund only the specific increment attempt it made.
  context: new RedisRateLimitContext({
    failurePolicy,
    ...(localMax === undefined ? {} : { localMax }),
    ...(onLocalFallback === undefined ? {} : { onLocalFallback }),
  }),
  generator: requestScopedGenerator(scope, counterKeyGenerator),
});

// One key per counter, read and written alone, so the counter itself is the
// colocation unit: the keyspace spreads across the ring instead of piling
// every limiter onto one node.
const redisRateLimitKey = (counterKey: string): CoordinationKey =>
  coordinationKey({ scope: "api-ratelimit", slot: counterKey });

const parseIncrementReply = (
  reply: unknown,
  durationMs: number,
  now: number,
): RateLimitCounter => {
  if (!isUnknownArray(reply) || reply.length !== 2) {
    throw new RedisRateLimitReplyError({
      message: "Redis returned an invalid rate-limit counter reply",
      reply,
    });
  }
  const count = reply.at(0);
  const ttlMs = reply.at(1);
  if (
    typeof count !== "number" ||
    typeof ttlMs !== "number" ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(ttlMs) ||
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
