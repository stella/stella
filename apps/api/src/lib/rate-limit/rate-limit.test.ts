import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import type { Options } from "elysia-rate-limit";
import { rateLimit } from "elysia-rate-limit";

import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

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
  test("shares counters, window expiry, and refunds across replicas", async () => {
    const redisState = createFakeRedisState();
    const first = createContext(redisState);
    const second = createContext(redisState);

    expect(
      (await first.increment("translate:client", WINDOW_MS, 1000)).count,
    ).toBe(1);
    expect(
      (await second.increment("translate:client", WINDOW_MS, 1000)).count,
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

    await first.decrement("translate:client");
    expect(
      (await second.increment("translate:client", WINDOW_MS, 1000)).count,
    ).toBe(2);

    redisState.now = 2001;
    expect(
      (await first.increment("translate:client", WINDOW_MS, 2001)).count,
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

  test("does not refund Redis after the matching increment fell back locally", async () => {
    let decrementCalled = false;
    const context = new RedisRateLimitContext({
      createRedis: () => ({
        send: async (_command, args) => {
          const script = requiredArg(args, 0);
          if (script.includes('redis.call("INCR"')) {
            throw new TypeError("Redis unavailable");
          }
          if (script.includes('redis.call("DECR"')) {
            decrementCalled = true;
            return 0;
          }
          throw new TypeError("Unexpected Redis script");
        },
      }),
      failurePolicy: "fail_open_local",
      onRedisError: () => undefined,
    });
    context.init(RATE_LIMIT_OPTIONS);

    expect((await context.increment("api:client")).count).toBe(1);
    await context.decrement("api:client");

    expect(decrementCalled).toBe(false);
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
    if (script.includes('redis.call("INCR"')) {
      return this.increment(key, Number(requiredArg(args, 3)));
    }
    if (script.includes('redis.call("DECR"')) {
      return this.decrement(key);
    }
    throw new TypeError("Unexpected Redis script");
  }

  private increment(key: string, durationMs: number): [number, number] {
    const current = this.state.entries.get(key);
    if (current === undefined || current.expiresAt <= this.state.now) {
      this.state.entries.set(key, {
        count: 1,
        expiresAt: this.state.now + durationMs,
      });
      return [1, durationMs];
    }
    current.count += 1;
    return [current.count, current.expiresAt - this.state.now];
  }

  private decrement(key: string): number {
    const current = this.state.entries.get(key);
    if (current === undefined || current.count <= 0) {
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
