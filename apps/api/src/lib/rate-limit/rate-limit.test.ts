import { describe, expect, test } from "bun:test";
import Elysia, { t } from "elysia";

import {
  rateLimit,
  type RateLimitContext,
  type RateLimitContextConfig,
  type RateLimitOptions,
} from "@/api/lib/rate-limit/rate-limit";
import {
  createRedisRateLimit,
  createRedisRateLimitRequestKey,
  RedisRateLimitContext,
} from "@/api/lib/rate-limit/redis-context";

const WINDOW_MS = 1000;
const RATE_LIMIT_OPTIONS = {
  duration: WINDOW_MS,
  generator: () => "shared-client",
  max: 2,
  skip: () => false,
} as const satisfies Omit<RateLimitOptions, "context">;

describe("RedisRateLimitContext", () => {
  test("keeps one refund identity per request while sharing the counter key", async () => {
    const { context, generator } = createRedisRateLimit({
      failurePolicy: "fail_open_local",
      scope: "api",
    });
    const firstRequest = Object.assign(new Request("http://localhost/one"), {
      cookie: {},
    });
    const secondRequest = Object.assign(new Request("http://localhost/two"), {
      cookie: {},
    });

    const firstKey = await generator(firstRequest, null);
    const repeatedKey = await generator(firstRequest, null);
    const secondKey = await generator(secondRequest, null);

    expect(firstKey).toBe(repeatedKey);
    expect(secondKey).not.toBe(firstKey);
    expect(firstKey.startsWith("api")).toBe(true);
    expect(secondKey.startsWith("api")).toBe(true);
    await context.kill();
  });

  test("shares counters, window expiry, and refunds across replicas", async () => {
    const redisState = createFakeRedisState();
    const first = createContext(redisState);
    const second = createContext(redisState);
    const firstTranslateRequest = requestKey("translate:client");

    expect(
      (await first.increment(firstTranslateRequest, WINDOW_MS, 1000)).count,
    ).toBe(1);
    expect(
      (await second.increment(requestKey("translate:client"), WINDOW_MS, 1000))
        .count,
    ).toBe(2);
    expect(
      (await second.increment("upload:client", WINDOW_MS, 1000)).count,
    ).toBe(1);
    expect(
      (await first.increment("upload:client", WINDOW_MS, 1000)).count,
    ).toBe(2);
    await second.reset("upload:client");
    expect(
      (await first.increment("upload:client", WINDOW_MS, 1000)).count,
    ).toBe(1);

    await first.decrement(firstTranslateRequest);
    expect(
      (await second.increment(requestKey("translate:client"), WINDOW_MS, 1000))
        .count,
    ).toBe(2);

    redisState.now = 2001;
    expect(
      (await first.increment(requestKey("translate:client"), WINDOW_MS, 2001))
        .count,
    ).toBe(1);

    first.kill();
    second.kill();
  });

  test("falls back locally on malformed Redis replies", async () => {
    const operations: string[] = [];
    const context = new RedisRateLimitContext({
      createRedis: () => ({
        send: async () => ["malformed"],
      }),
      failurePolicy: "fail_open_local",
      onRedisError: (_error, operation) => {
        operations.push(operation);
      },
    });
    context.init(RATE_LIMIT_OPTIONS);

    expect((await context.increment("api:client", WINDOW_MS, 1000)).count).toBe(
      1,
    );
    expect((await context.increment("api:client", WINDOW_MS, 1000)).count).toBe(
      2,
    );
    expect(operations).toEqual(["increment", "increment"]);
    context.kill();
  });

  test("connects the client at construction and reports a failed connect", async () => {
    const operations: string[] = [];
    let connectCalls = 0;
    let rejectConnect: (error: Error) => void = () => undefined;
    const context = new RedisRateLimitContext({
      createRedis: () => ({
        connect: async () => {
          connectCalls += 1;
          await new Promise<void>((_resolve, reject) => {
            rejectConnect = reject;
          });
        },
        send: async () => [1, WINDOW_MS],
      }),
      failurePolicy: "fail_open_local",
      onRedisError: (_error, operation) => {
        operations.push(operation);
      },
    });
    // The connect starts before any request, so the first increment finds a
    // client that is already connecting rather than one it has to create.
    expect(connectCalls).toBe(1);
    context.init(RATE_LIMIT_OPTIONS);
    expect((await context.increment("api:client", WINDOW_MS, 1000)).count).toBe(
      1,
    );
    expect(connectCalls).toBe(1);

    rejectConnect(new Error("connect ECONNREFUSED"));
    await Bun.sleep(0);
    expect(operations).toEqual(["connect"]);
    context.kill();
  });

  test("bounds a stalled command and cancels its timer", async () => {
    let clientClosed = false;
    let lateMutationApplied = false;
    let settleCommand: (() => void) | undefined;
    let timerCancelled = false;
    const context = new RedisRateLimitContext({
      commandTimeoutMs: 500,
      createRedis: () => ({
        close: () => {
          clientClosed = true;
        },
        send: async () =>
          await new Promise<[number, number]>((resolve) => {
            settleCommand = () => {
              if (!clientClosed) {
                lateMutationApplied = true;
              }
              resolve([1, WINDOW_MS]);
            };
          }),
      }),
      failurePolicy: "fail_open_local",
      onRedisError: () => undefined,
      scheduleTimeout: (callback) => {
        queueMicrotask(callback);
        return () => {
          timerCancelled = true;
        };
      },
    });
    context.init(RATE_LIMIT_OPTIONS);

    const counter = await context.increment("api:client", WINDOW_MS, 1000);

    expect(counter.count).toBe(1);
    expect(clientClosed).toBe(true);
    expect(timerCancelled).toBe(true);
    settleCommand?.();
    await Promise.resolve();
    expect(lateMutationApplied).toBe(false);
    context.kill();
  });

  test("refunds an increment that reached Redis after the client already timed out", async () => {
    const redisState = createFakeRedisState();
    const fakeClient = new FakeRedisClient(redisState);
    let releaseLateReply: (() => void) | undefined;
    let delayNextIncrement = true;
    const context = new RedisRateLimitContext({
      createRedis: () => ({
        send: async (command, args) => {
          // Apply against shared state synchronously -- mirroring Redis
          // executing the EVAL -- but withhold the reply until the test
          // releases it, simulating a reply that arrives after the client
          // gave up waiting.
          const applyResultPromise = fakeClient.send(command, args);
          const script = requiredArg(args, 0);
          if (
            command === "EVAL" &&
            script.includes('redis.call("HSET"') &&
            delayNextIncrement
          ) {
            delayNextIncrement = false;
            return await new Promise<unknown>((resolve) => {
              releaseLateReply = () => {
                applyResultPromise.then(resolve).catch(() => undefined);
              };
            });
          }
          return await applyResultPromise;
        },
      }),
      failurePolicy: "fail_open_local",
      onRedisError: () => undefined,
      scheduleTimeout: (callback) => {
        queueMicrotask(callback);
        return () => undefined;
      },
    });
    context.init(RATE_LIMIT_OPTIONS);

    const key = requestKey("api:client");
    const counter = await context.increment(key, WINDOW_MS, 1000);
    // The client-side timeout fires first, so the caller only sees the
    // local fallback counter -- but Redis already applied the increment.
    expect(counter.count).toBe(1);

    await context.decrement(key);
    releaseLateReply?.();
    await Promise.resolve();

    // A separate, healthy context proves the earlier increment was
    // refunded in Redis rather than left as a permanent over-count: a
    // fresh request against the same counter starts back at 1, not 2.
    const healthyContext = createContext(redisState);
    expect(
      (
        await healthyContext.increment(
          requestKey("api:client"),
          WINDOW_MS,
          1000,
        )
      ).count,
    ).toBe(1);
    healthyContext.kill();
    context.kill();
  });

  test("does not refund an increment that never reached Redis", async () => {
    const redisState = createFakeRedisState();
    const fakeClient = new FakeRedisClient(redisState);
    const context = new RedisRateLimitContext({
      createRedis: () => ({
        send: async (command, args) => {
          const script = requiredArg(args, 0);
          if (command === "EVAL" && script.includes('redis.call("HSET"')) {
            // Never resolves: this increment genuinely never reached Redis.
            return await new Promise<unknown>(() => {
              // Intentionally left pending.
            });
          }
          return await fakeClient.send(command, args);
        },
      }),
      failurePolicy: "fail_open_local",
      onRedisError: () => undefined,
      scheduleTimeout: (callback) => {
        queueMicrotask(callback);
        return () => undefined;
      },
    });
    context.init(RATE_LIMIT_OPTIONS);

    const key = requestKey("api:client");
    const counter = await context.increment(key, WINDOW_MS, 1000);
    expect(counter.count).toBe(1);

    await context.decrement(key);

    const healthyContext = createContext(redisState);
    expect(
      (
        await healthyContext.increment(
          requestKey("api:client"),
          WINDOW_MS,
          1000,
        )
      ).count,
    ).toBe(1);
    healthyContext.kill();
    context.kill();
  });

  test("suppresses fallback refunds without affecting healthy keys", async () => {
    const decrementedKeys: string[] = [];
    let failNextIncrement = true;
    const context = new RedisRateLimitContext({
      createRedis: () => ({
        send: async (_command, args) => {
          const script = requiredArg(args, 0);
          if (script.includes('redis.call("HSET"')) {
            if (failNextIncrement) {
              failNextIncrement = false;
              throw new TypeError("Redis unavailable");
            }
            return [1, WINDOW_MS];
          }
          if (script.includes('redis.call("HDEL"')) {
            decrementedKeys.push(requiredArg(args, 2));
            return 0;
          }
          throw new TypeError("Unexpected Redis script");
        },
      }),
      failurePolicy: "fail_open_local",
      onRedisError: () => undefined,
    });
    context.init(RATE_LIMIT_OPTIONS);

    const failedRequest = requestKey("api:failed");
    const healthyRequest = requestKey("api:healthy");
    expect((await context.increment(failedRequest)).count).toBe(1);
    await context.decrement(failedRequest);
    expect((await context.increment(healthyRequest)).count).toBe(1);
    await context.decrement(healthyRequest);

    expect(decrementedKeys).toEqual(["api-ratelimit:{api:healthy}"]);
    context.kill();
  });

  test("does not refund a newer Redis window", async () => {
    const redisState = createFakeRedisState();
    const context = createContext(redisState);
    const expiredRequest = requestKey("api:client");

    expect(
      (await context.increment(expiredRequest, WINDOW_MS, 1000)).count,
    ).toBe(1);
    redisState.now = 2001;
    expect(
      (await context.increment(requestKey("api:client"), WINDOW_MS, 2001))
        .count,
    ).toBe(1);

    await context.decrement(expiredRequest);

    expect(
      (await context.increment(requestKey("api:client"), WINDOW_MS, 2001))
        .count,
    ).toBe(2);
    context.kill();
  });

  test("can fail closed with normal rate-limit counter semantics", async () => {
    const context = new RedisRateLimitContext({
      createRedis: () => ({
        send: async () => {
          throw new TypeError("Redis unavailable");
        },
      }),
      failurePolicy: "fail_closed",
      onRedisError: () => undefined,
    });
    context.init(RATE_LIMIT_OPTIONS);

    const counter = await context.increment(
      "translate:client",
      WINDOW_MS,
      1000,
    );

    expect(counter.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(counter.nextReset).toEqual(new Date(2000));
    context.kill();
  });

  test("returns a combined 429 and exact retry headers across app instances", async () => {
    const redisState = createFakeRedisState();
    const firstContext = createContext(redisState);
    const secondContext = createContext(redisState);
    const firstApp = createRateLimitedApp(firstContext);
    const secondApp = createRateLimitedApp(secondContext);

    const first = await firstApp.handle(new Request("http://localhost/"));
    const second = await secondApp.handle(new Request("http://localhost/"));
    const limited = await firstApp.handle(new Request("http://localhost/"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("RateLimit-Limit")).toBe("2");
    expect(limited.headers.get("RateLimit-Remaining")).toBe("0");
    expect(limited.headers.get("RateLimit-Reset")).toBe("1");
    expect(limited.headers.get("Retry-After")).toBe("1");
    expect(await limited.text()).toBe("rate-limit reached");
    firstContext.kill();
    secondContext.kill();
  });

  test("refunds only requests that reached a failing handler", async () => {
    const context = new TrackingRateLimitContext();
    const app = createTrackingRateLimitedApp({ context, max: 1 })
      .get("/fails", () => {
        throw new TypeError("handler failed");
      })
      .get("/passes", () => "ok");

    const failed = await app.handle(new Request("http://localhost/fails"));
    const passed = await app.handle(new Request("http://localhost/passes"));
    const limited = await app.handle(new Request("http://localhost/passes"));

    expect(failed.status).toBe(500);
    expect(passed.status).toBe(200);
    expect(limited.status).toBe(429);
    expect(context.decrementedKeys).toEqual(["shared-client"]);
  });

  test("skipped failing requests cannot refund another request", async () => {
    const context = new TrackingRateLimitContext();
    const app = createTrackingRateLimitedApp({
      context,
      max: 1,
      skip: (request) => new URL(request.url).pathname === "/skipped",
    })
      .get("/skipped", () => {
        throw new TypeError("skipped handler failed");
      })
      .get("/limited", () => "ok");

    const skipped = await app.handle(new Request("http://localhost/skipped"));
    const passed = await app.handle(new Request("http://localhost/limited"));
    const limited = await app.handle(new Request("http://localhost/limited"));

    expect(skipped.status).toBe(500);
    expect(passed.status).toBe(200);
    expect(limited.status).toBe(429);
    expect(context.incrementedKeys).toEqual(["shared-client", "shared-client"]);
    expect(context.decrementedKeys).toEqual([]);
  });

  test("counts malformed and request-validation failures", async () => {
    const context = new TrackingRateLimitContext();
    const app = createTrackingRateLimitedApp({ context, max: 2 }).post(
      "/",
      () => "ok",
      { body: t.Object({ name: t.String() }) },
    );

    const malformed = await app.handle(
      new Request("http://localhost/", {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const invalid = await app.handle(
      new Request("http://localhost/", {
        body: JSON.stringify({ name: 42 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const limited = await app.handle(
      new Request("http://localhost/", {
        body: JSON.stringify({ name: "Stella" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(422);
    expect(limited.status).toBe(429);
    expect(context.incrementedKeys).toEqual([
      "shared-client",
      "shared-client",
      "shared-client",
    ]);
  });

  test("counts unknown routes that bypass before-handle hooks", async () => {
    const context = new TrackingRateLimitContext();
    const app = createTrackingRateLimitedApp({ context, max: 1 }).get(
      "/known",
      () => "ok",
    );

    const missing = await app.handle(new Request("http://localhost/missing"));
    const limited = await app.handle(new Request("http://localhost/known"));

    expect(missing.status).toBe(404);
    expect(limited.status).toBe(429);
    expect(context.incrementedKeys).toEqual(["shared-client", "shared-client"]);
  });

  test("registers equal-limit scoped plugins independently", async () => {
    const firstContext = new TrackingRateLimitContext();
    const secondContext = new TrackingRateLimitContext();
    const app = new Elysia()
      .use(
        createTrackingRateLimitedApp({
          context: firstContext,
          max: 1,
          prefix: "/first",
        }).get("/", () => "first"),
      )
      .use(
        createTrackingRateLimitedApp({
          context: secondContext,
          max: 1,
          prefix: "/second",
        }).get("/", () => "second"),
      );

    const first = await app.handle(new Request("http://localhost/first/"));
    const second = await app.handle(new Request("http://localhost/second/"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstContext.incrementedKeys).toEqual(["shared-client"]);
    expect(secondContext.incrementedKeys).toEqual(["shared-client"]);
  });

  test("cleans up its context when the app stops", async () => {
    const context = new TrackingRateLimitContext();
    const app = createTrackingRateLimitedApp({ context, max: 1 })
      .get("/", () => "ok")
      .listen({ hostname: "127.0.0.1", port: 0 });

    await app.stop();

    expect(context.killCount).toBe(1);
  });
});

class TrackingRateLimitContext implements RateLimitContext {
  readonly decrementedKeys: string[] = [];
  readonly incrementedKeys: string[] = [];
  killCount = 0;
  private readonly counts = new Map<string, number>();
  private duration = WINDOW_MS;

  decrement(key: string): void {
    this.decrementedKeys.push(key);
    const count = this.counts.get(key) ?? 0;
    this.counts.set(key, Math.max(0, count - 1));
  }

  increment(key: string, duration = this.duration, requestTime = Date.now()) {
    this.incrementedKeys.push(key);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return {
      count,
      nextReset: new Date(requestTime + duration),
      start: requestTime,
    };
  }

  init({ duration }: RateLimitContextConfig): void {
    this.duration = duration;
  }

  kill(): void {
    this.killCount += 1;
    this.counts.clear();
  }
}

const createTrackingRateLimitedApp = ({
  context,
  max,
  prefix,
  skip,
}: {
  context: TrackingRateLimitContext;
  max: number;
  prefix?: string;
  skip?: RateLimitOptions["skip"];
}) =>
  new Elysia(prefix === undefined ? {} : { prefix }).use(
    rateLimit({
      context,
      duration: WINDOW_MS,
      generator: () => "shared-client",
      max,
      ...(skip === undefined ? {} : { skip }),
    }),
  );

type FakeRedisEntry = {
  attempts: Set<string>;
  count: number;
  expiresAt: number;
};

type FakeRedisState = {
  entries: Map<string, FakeRedisEntry>;
  now: number;
};

const createFakeRedisState = (): FakeRedisState => ({
  entries: new Map(),
  now: 1000,
});

class FakeRedisClient {
  private readonly state: FakeRedisState;

  constructor(state: FakeRedisState) {
    this.state = state;
  }

  async send(command: string, args: string[]): Promise<unknown> {
    if (command === "DEL") {
      return this.state.entries.delete(requiredArg(args, 0)) ? 1 : 0;
    }
    if (command !== "EVAL") {
      throw new TypeError(`Unexpected Redis command: ${command}`);
    }

    const script = requiredArg(args, 0);
    const key = requiredArg(args, 2);
    if (script.includes('redis.call("HSET"')) {
      return this.increment(
        key,
        Number(requiredArg(args, 3)),
        requiredArg(args, 4),
      );
    }
    if (script.includes('redis.call("HDEL"')) {
      return this.decrement(key, requiredArg(args, 3));
    }
    throw new TypeError("Unexpected Redis script");
  }

  private increment(
    key: string,
    durationMs: number,
    attemptId: string,
  ): [number, number] {
    const current = this.state.entries.get(key);
    if (current === undefined || current.expiresAt <= this.state.now) {
      this.state.entries.set(key, {
        attempts: new Set([attemptId]),
        count: 1,
        expiresAt: this.state.now + durationMs,
      });
      return [1, durationMs];
    }
    current.count += 1;
    current.attempts.add(attemptId);
    return [current.count, current.expiresAt - this.state.now];
  }

  private decrement(key: string, attemptId: string): number {
    const current = this.state.entries.get(key);
    if (
      current === undefined ||
      current.count <= 0 ||
      !current.attempts.has(attemptId)
    ) {
      return current?.count ?? 0;
    }
    current.attempts.delete(attemptId);
    current.count -= 1;
    return current.count;
  }
}

const requiredArg = (args: string[], index: number): string => {
  const value = args.at(index);
  if (value === undefined) {
    throw new TypeError(`Missing Redis argument at index ${index}`);
  }
  return value;
};

let requestSequence = 0;
const requestKey = (counterKey: string): string => {
  requestSequence += 1;
  return createRedisRateLimitRequestKey({
    counterKey,
    requestId: `request-${requestSequence}`,
  });
};

const createContext = (redisState: FakeRedisState): RedisRateLimitContext => {
  const context = new RedisRateLimitContext({
    createRedis: () => new FakeRedisClient(redisState),
    failurePolicy: "fail_open_local",
    onRedisError: () => undefined,
  });
  context.init(RATE_LIMIT_OPTIONS);
  return context;
};

const createRateLimitedApp = (context: RedisRateLimitContext) =>
  new Elysia()
    .use(
      rateLimit({
        ...RATE_LIMIT_OPTIONS,
        context,
      }),
    )
    .get("/", () => "ok");
