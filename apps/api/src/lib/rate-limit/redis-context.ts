import { Result, TaggedError } from "better-result";
import type { Context, Generator, Options } from "elysia-rate-limit";

import { detached } from "@/api/lib/detached";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import {
  defaultScheduleTimeout,
  type ScheduleTimeout,
  withCommandTimeout,
} from "@/api/lib/rate-limit/redis-command-timeout";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey, type CoordinationKey } from "@/api/lib/redis-keys";

const REQUEST_KEY_SEPARATOR = "\u001f";
const REDIS_COMMAND_TIMEOUT_MS = 500;
const REFUND_PROVENANCE_CLEANUP_INTERVAL_MS = 60_000;
const FAIL_CLOSED_COUNT = Number.MAX_SAFE_INTEGER;

// Every increment attempt is tagged with a client-generated attempt id
// (ARGV[2]) that the script records unconditionally, independent of
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
redis.call("HSET", KEYS[1], "attempt:" .. ARGV[2], "1")
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

const REDIS_RATE_LIMIT_FAILURE_POLICIES = [
  "fail_open_local",
  "fail_closed",
] as const;
type RedisRateLimitFailurePolicy =
  (typeof REDIS_RATE_LIMIT_FAILURE_POLICIES)[number];

type RedisRateLimitClient = {
  close?: () => void;
  /**
   * Opens the socket ahead of the first command. The client runs with the
   * offline queue disabled, so a command issued before the socket is up
   * rejects at once instead of waiting; connecting at construction keeps the
   * first requests after a process start on Redis rather than on the
   * per-process fallback.
   */
  connect?: () => Promise<void>;
  send: (command: string, args: string[]) => Promise<unknown>;
};

type RedisRateLimitOperation = "connect" | "decrement" | "increment" | "reset";

type RedisRateLimitContextOptions = {
  commandTimeoutMs?: number;
  createRedis?: () => RedisRateLimitClient;
  failurePolicy: RedisRateLimitFailurePolicy;
  onRedisError?: (error: unknown, operation: RedisRateLimitOperation) => void;
  scheduleTimeout?: ScheduleTimeout;
};

type CreateRedisRateLimitOptions = {
  counterKeyGenerator?: Generator;
  failurePolicy: RedisRateLimitFailurePolicy;
  scope: string;
};

type RedisRateLimitBinding = Pick<Options, "context" | "generator">;

type RateLimitCounter = {
  count: number;
  nextReset: Date;
  start: number;
};

type RefundProvenance = {
  /**
   * The attempt id sent with the increment EVAL. Kept even when the
   * increment's own reply never arrived (client-side timeout): Redis may
   * have already applied that EVAL before the timeout fired, and
   * DECREMENT_SCRIPT's attempt-id match makes refunding against an
   * unconfirmed attempt safe either way -- it decrements only if Redis
   * actually recorded this attempt, and no-ops otherwise. Discarding
   * provenance on timeout (the previous behavior) traded that bounded
   * ambiguity for a guaranteed permanent over-count whenever the EVAL had
   * in fact landed.
   */
  attemptId: string;
  counterKey: string;
  expiresAt: number;
};

class RedisRateLimitReplyError extends TaggedError("RedisRateLimitReplyError")<{
  message: string;
  reply: unknown;
}> {}

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
    this.openRedis();
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
    const attemptId = Bun.randomUUIDv7();
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
      this.onRedisError(redisResult.error, "increment");
      if (requestId !== null) {
        if (TimeoutError.is(redisResult.error)) {
          // The client gave up waiting, but the EVAL may already have
          // reached and executed on Redis -- there is no way to tell from
          // here. Retain provenance keyed by the attempt id we sent (not
          // a window id, since we never received one) so a later
          // decrement() can still attempt a refund; DECREMENT_SCRIPT
          // resolves the ambiguity server-side.
          this.refundProvenanceByRequest.set(requestId, {
            attemptId,
            counterKey,
            expiresAt: now + effectiveDuration,
          });
        } else {
          this.refundProvenanceByRequest.delete(requestId);
        }
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
        attemptId,
        counterKey,
        expiresAt: redisResult.value.nextReset.getTime(),
      });
    }
    return redisResult.value;
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
    const redis = this.redis;
    this.redis = null;
    redis?.close?.();
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

  /**
   * Builds the client and starts connecting it without waiting: construction
   * and the request path never block on the socket. Commands issued before
   * the socket is up reject and take the failure policy, exactly as during an
   * outage. The client reconnects on its own while the peer refuses, so the
   * promise settles only once a connection exists, the client's own retries
   * run out, or the client is closed; a rejection is reported through
   * `onRedisError` rather than the cold-start retry ladder, whose per-attempt
   * rejection this client never produces.
   */
  private openRedis(): RedisRateLimitClient {
    const redis = this.createRedis();
    this.redis = redis;
    if (redis.connect === undefined) {
      return redis;
    }
    detached(
      redis.connect().catch((error: unknown) => {
        // A client replaced or closed while still connecting is not this
        // context's connection any more; its outcome is nobody's news.
        if (this.redis === redis) {
          this.onRedisError(error, "connect");
        }
      }),
      "rate-limit.redis-connect",
    );
    return redis;
  }

  private async sendCommand(command: string, args: string[]): Promise<unknown> {
    const redis = this.redis ?? this.openRedis();
    const result = await Result.tryPromise({
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
      if (TimeoutError.is(result.error)) {
        if (this.redis === redis) {
          this.redis = null;
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
): Generator => {
  const requestIds = new WeakMap<Request, string>();

  return async (request, server, derived) => {
    const counterKey = await counterKeyGenerator(request, server, derived);
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
  scope,
}: CreateRedisRateLimitOptions): RedisRateLimitBinding => ({
  // Keep the context and request-token generator paired: the token lets a
  // failed request refund only the specific increment attempt it made.
  context: new RedisRateLimitContext({ failurePolicy }),
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
