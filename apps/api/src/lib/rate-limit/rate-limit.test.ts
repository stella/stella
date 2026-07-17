import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import type { Options } from "elysia-rate-limit";
import { rateLimit } from "elysia-rate-limit";

import {
  createRedisRateLimit,
  createRedisRateLimitRequestKey,
  RedisRateLimitContext,
} from "@/api/lib/rate-limit/redis-context";

const WINDOW_MS = 1000;
const RATE_LIMIT_OPTIONS = {
  countFailedRequest: false,
  duration: WINDOW_MS,
  errorResponse: "rate limit reached",
  generator: () => "shared-client",
  headers: true,
  max: 2,
  scoping: "scoped",
  skip: () => false,
} as const satisfies Omit<Options, "context">;

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

    const firstKey = await generator(firstRequest, null, {});
    const repeatedKey = await generator(firstRequest, null, {});
    const secondKey = await generator(secondRequest, null, {});

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
          await new Promise<[number, number, string]>((resolve) => {
            settleCommand = () => {
              if (!clientClosed) {
                lateMutationApplied = true;
              }
              resolve([1, WINDOW_MS, "window-timeout"]);
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
            return [1, WINDOW_MS, "window-healthy"];
          }
          if (script.includes("~= ARGV[1]")) {
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

    expect(decrementedKeys).toEqual(["api:ratelimit:v2:api:healthy"]);
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
    firstContext.kill();
    secondContext.kill();
  });
});

type FakeRedisEntry = {
  count: number;
  expiresAt: number;
  windowId: string;
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
    if (script.includes("~= ARGV[1]")) {
      return this.decrement(key, requiredArg(args, 3));
    }
    throw new TypeError("Unexpected Redis script");
  }

  private increment(
    key: string,
    durationMs: number,
    candidateWindowId: string,
  ): [number, number, string] {
    const current = this.state.entries.get(key);
    if (current === undefined || current.expiresAt <= this.state.now) {
      this.state.entries.set(key, {
        count: 1,
        expiresAt: this.state.now + durationMs,
        windowId: candidateWindowId,
      });
      return [1, durationMs, candidateWindowId];
    }
    current.count += 1;
    return [
      current.count,
      current.expiresAt - this.state.now,
      current.windowId,
    ];
  }

  private decrement(key: string, expectedWindowId: string): number {
    const current = this.state.entries.get(key);
    if (
      current === undefined ||
      current.count <= 0 ||
      current.windowId !== expectedWindowId
    ) {
      return 0;
    }
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
