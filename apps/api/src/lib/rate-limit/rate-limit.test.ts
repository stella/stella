import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import Elysia, { status, t } from "elysia";

import { toSafeId } from "@/api/lib/branded-types";
import { parseTrustedProxies } from "@/api/lib/client-ip";
import { withDemoActionBudget } from "@/api/lib/rate-limit/demo-action-budget";
import {
  createOtpAccountBudget,
  OTP_ACCOUNT_BUDGET,
} from "@/api/lib/rate-limit/otp-account-budget";
import {
  InMemoryRateLimitContext,
  scopedGenerator,
  scopedRateLimitKey,
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
import { consumeSignupOtpRateLimit } from "@/api/lib/signup-abuse";

const WINDOW_MS = 1000;
const RATE_LIMIT_OPTIONS = {
  duration: WINDOW_MS,
  generator: () => "shared-client",
  max: 2,
  skip: () => false,
} as const satisfies Omit<RateLimitOptions, "context">;

class TrackingRateLimitContext implements RateLimitContext {
  readonly completedKeys: string[] = [];
  readonly decrementedKeys: string[] = [];
  readonly incrementedKeys: string[] = [];
  killCount = 0;
  private readonly counts = new Map<string, number>();
  private duration = WINDOW_MS;

  complete(key: string): void {
    this.completedKeys.push(key);
  }

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

class FakeRedisClient {
  private readonly state: FakeRedisState;

  constructor(state: FakeRedisState) {
    this.state = state;
  }

  async send(command: string, args: string[]): Promise<unknown> {
    if (command === "HDEL") {
      const current = this.state.entries.get(requiredArg(args, 0));
      return current?.attempts.delete(
        requiredArg(args, 1).slice("attempt:".length),
      )
        ? 1
        : 0;
    }
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
        script.includes('if ARGV[2] ~= "" then'),
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
    conditionalMarker: boolean,
  ): [number, number] {
    const current = this.state.entries.get(key);
    if (current === undefined || current.expiresAt <= this.state.now) {
      this.state.entries.set(key, {
        attempts: new Set(
          conditionalMarker && attemptId === "" ? [] : [attemptId],
        ),
        count: 1,
        expiresAt: this.state.now + durationMs,
      });
      return [1, durationMs];
    }
    current.count += 1;
    if (!conditionalMarker || attemptId !== "") {
      current.attempts.add(attemptId);
    }
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

  test("direct signup counters never allocate refund markers", async () => {
    const state = createFakeRedisState();
    const context = createContext(state);
    try {
      for (const kind of ["email", "ip"] as const) {
        for (let count = 1; count <= 40; count += 1) {
          const result = await consumeSignupOtpRateLimit({
            context,
            identity: kind === "email" ? "fixture@example.test" : "192.0.2.1",
            kind,
          });
          expect(result.count).toBe(count);
        }
      }
      expect(
        [...state.entries.values()].map(({ attempts }) => attempts.size),
      ).toEqual([0, 0]);
      expect([...state.entries.values()].map(({ count }) => count)).toEqual([
        40, 40,
      ]);
    } finally {
      await context.kill();
    }
  });

  test("direct OTP completions and refusals retain counts without refund markers", async () => {
    const state = createFakeRedisState();
    const context = createContext(state);
    const budget = createOtpAccountBudget(context, undefined);
    try {
      for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max; attempt += 1) {
        const reservation = await budget.reserve("fixture@example.test");
        expect(Result.isOk(reservation)).toBe(true);
        await budget.complete(reservation.unwrap(), false);
      }
      expect(Result.isError(await budget.reserve("fixture@example.test"))).toBe(
        true,
      );
      expect([...state.entries.values()].at(0)?.attempts.size).toBe(0);
      expect([...state.entries.values()].at(0)?.count).toBe(
        OTP_ACCOUNT_BUDGET.max + 1,
      );
      const successful = await budget.reserve("success@example.test");
      await budget.complete(successful.unwrap(), true);
      expect(
        [...state.entries.values()].map(({ attempts }) => attempts.size),
      ).toEqual([0, 0]);
      expect([...state.entries.values()].map(({ count }) => count)).toEqual([
        OTP_ACCOUNT_BUDGET.max + 1,
        0,
      ]);
    } finally {
      await context.kill();
    }
  });

  test("direct demo actions settle their successful daily attempts", async () => {
    const state = createFakeRedisState();
    const context = createContext(state);
    const userId = toSafeId<"user">("synthetic-user");
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await withDemoActionBudget({
          organizationId: toSafeId<"organization">("synthetic-organization"),
          userId,
          scope: "independent",
          budget: {
            counter: () => context,
            now: () => state.now,
            resolveDemoUserId: async () => userId,
          },
          run: async (markStarted) => {
            markStarted();
            return Result.ok("complete");
          },
        });
        expect(Result.isOk(result)).toBe(true);
      }
      expect([...state.entries.values()].at(0)?.attempts.size).toBe(0);
      expect([...state.entries.values()].at(0)?.count).toBe(40);
    } finally {
      await context.kill();
    }
  });

  test("completed long-window requests retain quota counts without refund markers", async () => {
    const state = createFakeRedisState();
    const context = createContext(state);
    const completed: string[] = [];
    const complete = context.complete.bind(context);
    context.complete = async (key) => {
      await complete(key);
      completed.push(key);
    };
    const app = new Elysia()
      .use(
        rateLimit({
          context,
          duration: 86_400_000,
          max: 1,
          generator: () => requestKey("daily"),
        }),
      )
      .get("/resolve", () => "resolved");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await app.handle(
        new Request("http://localhost/resolve"),
      );
      expect(response.status).toBe(attempt === 0 ? 200 : 429);
    }
    // After-response hooks finish asynchronously; wait for this observable work.
    await Bun.sleep(0);
    expect(completed).toHaveLength(40);
    expect(
      [...state.entries.values()].map(({ attempts }) => attempts.size),
    ).toEqual([0]);
    expect([...state.entries.values()].map(({ count }) => count)).toEqual([40]);
    const next = requestKey("daily");
    expect((await context.increment(next, 86_400_000)).count).toBe(41);
    await context.decrement(next);
    expect([...state.entries.values()].at(0)?.count).toBe(40);
    context.kill();
  });

  test("completing one request preserves an in-flight request's refund", async () => {
    const state = createFakeRedisState();
    const context = createContext(state);
    const completed = requestKey("daily");
    const pending = requestKey("daily");
    await context.increment(completed, 86_400_000);
    await context.increment(pending, 86_400_000);
    await context.complete(completed);
    expect([...state.entries.values()].at(0)?.attempts.size).toBe(1);
    expect([...state.entries.values()].at(0)?.count).toBe(2);
    await context.decrement(pending);
    expect([...state.entries.values()].at(0)?.count).toBe(1);
    expect([...state.entries.values()].at(0)?.attempts.size).toBe(0);
    await context.decrement(completed);
    expect([...state.entries.values()].at(0)?.count).toBe(1);
    context.kill();
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
            return await new Promise<unknown>((resolve, reject) => {
              releaseLateReply = () => {
                applyResultPromise.then(resolve).catch(reject);
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

  test("counts handlers that return a failed status", async () => {
    const context = new TrackingRateLimitContext();
    const app = createTrackingRateLimitedApp({ context, max: 1 })
      .get("/fails", () => status(400, { message: "failed" }))
      .get("/passes", () => "ok");

    const failed = await app.handle(new Request("http://localhost/fails"));
    const limited = await app.handle(new Request("http://localhost/passes"));

    expect(failed.status).toBe(400);
    expect(limited.status).toBe(429);
    expect(context.decrementedKeys).toEqual([]);
  });

  test("refunds thrown failures after an earlier error handler returns", async () => {
    const context = new TrackingRateLimitContext();
    const app = new Elysia()
      .onError(({ set }) => {
        set.status = 500;
        return { message: "sanitized" };
      })
      .use(
        rateLimit({
          context,
          duration: WINDOW_MS,
          generator: () => "shared-client",
          max: 1,
        }),
      )
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

  test("accounts for early failures after an earlier error handler returns", async () => {
    const context = new TrackingRateLimitContext();
    const app = new Elysia()
      .onError(({ code, set }) => {
        switch (code) {
          case "NOT_FOUND":
            set.status = 404;
            break;
          case "PARSE":
            set.status = 400;
            break;
          case "VALIDATION":
            set.status = 422;
            break;
          case "INTERNAL_SERVER_ERROR":
          case "INVALID_COOKIE_SIGNATURE":
          case "INVALID_FILE_TYPE":
          case "UNKNOWN":
            set.status = 500;
            break;
          default:
            set.status = 500;
        }
        return { message: "sanitized" };
      })
      .use(
        rateLimit({
          context,
          duration: WINDOW_MS,
          generator: () => "shared-client",
          max: 3,
        }),
      )
      .post("/known", () => "ok", {
        body: t.Object({ name: t.String() }),
      });

    const malformed = await app.handle(
      new Request("http://localhost/known", {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const invalid = await app.handle(
      new Request("http://localhost/known", {
        body: JSON.stringify({ name: 42 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const missing = await app.handle(
      new Request("http://localhost/missing", { method: "POST" }),
    );
    const limited = await app.handle(
      new Request("http://localhost/known", {
        body: JSON.stringify({ name: "Stella" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(422);
    expect(missing.status).toBe(404);
    expect(limited.status).toBe(429);
    expect(context.incrementedKeys).toEqual([
      "shared-client",
      "shared-client",
      "shared-client",
      "shared-client",
    ]);
  });

  test("returns the rate-limit body when an early failure exceeds the quota", async () => {
    const context = new TrackingRateLimitContext();
    const app = new Elysia()
      .onError(({ set }) => {
        set.status = 400;
        return { message: "sanitized" };
      })
      .use(
        rateLimit({
          context,
          duration: WINDOW_MS,
          generator: () => "shared-client",
          max: 1,
        }),
      )
      .post("/known", () => "ok", {
        body: t.Object({ name: t.String() }),
      });

    const first = await app.handle(
      new Request("http://localhost/known", {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const limited = await app.handle(
      new Request("http://localhost/known", {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(first.status).toBe(400);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("RateLimit-Limit")).toBe("1");
    expect(limited.headers.get("RateLimit-Remaining")).toBe("0");
    expect(limited.headers.get("Retry-After")).toBe("1");
    expect(await limited.text()).toBe("rate-limit reached");
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

describe("client address counters", () => {
  const clientAddressOptions = {
    trusted: parseTrustedProxies("10.0.0.0/8"),
    edgeHeader: null,
  };
  const request = (address: string) =>
    new Request("https://example.test/", {
      headers: { "x-forwarded-for": address },
    });

  test("keeps the direct peer counter when forwarded values change", () => {
    const server = { requestIP: () => ({ address: "192.0.2.10" }) };
    const context = new InMemoryRateLimitContext();
    context.init(RATE_LIMIT_OPTIONS);
    try {
      for (const [index, address] of [
        "198.51.100.1",
        "198.51.100.2",
        "198.51.100.3",
      ].entries()) {
        const key = scopedRateLimitKey({
          scope: "api",
          request: request(address),
          server,
          clientAddressOptions,
        });
        expect(key).toBe("api:192.0.2.10");
        const counter = context.increment(key, WINDOW_MS, 1000);
        expect(counter.count).toBe(index + 1);
        expect(counter.count <= RATE_LIMIT_OPTIONS.max).toBe(index < 2);
      }
    } finally {
      context.kill();
    }
  });

  test("keeps clients on one configured peer in separate counters", () => {
    const server = { requestIP: () => ({ address: "10.1.2.3" }) };
    const context = new InMemoryRateLimitContext();
    context.init(RATE_LIMIT_OPTIONS);
    const key = (address: string) =>
      scopedRateLimitKey({
        scope: "api",
        request: request(address),
        server,
        clientAddressOptions,
      });
    try {
      const first = key("198.51.100.1");
      const second = key("198.51.100.2");
      expect(first).toBe("api:198.51.100.1");
      expect(second).toBe("api:198.51.100.2");
      for (let count = 1; count <= 3; count += 1) {
        expect(context.increment(first, WINDOW_MS, 1000).count).toBe(count);
      }
      expect(
        context.increment(first, WINDOW_MS, 1000).count <=
          RATE_LIMIT_OPTIONS.max,
      ).toBe(false);
      expect(
        context.increment(second, WINDOW_MS, 1000).count <=
          RATE_LIMIT_OPTIONS.max,
      ).toBe(true);
    } finally {
      context.kill();
    }
  });

  test("shares one canonical IPv6 /64 counter while separating adjacent networks", () => {
    const server = { requestIP: () => ({ address: "10.1.2.3" }) };
    const context = new InMemoryRateLimitContext();
    context.init(RATE_LIMIT_OPTIONS);
    const key = (address: string) =>
      scopedRateLimitKey({
        scope: "api",
        request: request(address),
        server,
        clientAddressOptions,
      });
    try {
      const identities = [
        "2001:db8:abcd:1234::1",
        "2001:0DB8:ABCD:1234:0000:0000:0000:0001",
        "2001:db8:abcd:1234:ffff:ffff:ffff:ffff",
      ];
      for (const [index, address] of identities.entries()) {
        expect(key(address)).toBe("api:2001:db8:abcd:1234::");
        expect(context.increment(key(address), WINDOW_MS, 1000).count).toBe(
          index + 1,
        );
      }
      expect(
        context.increment(key("2001:db8:abcd:1235::1"), WINDOW_MS, 1000).count,
      ).toBe(1);
    } finally {
      context.kill();
    }
  });

  test("keeps scope-only keys without a runtime address", () => {
    const synthetic = request("198.51.100.1");
    expect(
      scopedRateLimitKey({
        scope: "api",
        request: synthetic,
        server: null,
        clientAddressOptions,
      }),
    ).toBe("api");
    expect(scopedGenerator("api")(synthetic, null)).toBe("api");
    expect(
      scopedRateLimitKey({
        scope: "api",
        request: synthetic,
        server: { requestIP: () => null },
        clientAddressOptions,
      }),
    ).toBe("api");
  });
});

describe("composed rate-limit response policies", () => {
  test("remaining budget and reset ties choose one complete policy regardless of registration order", async () => {
    for (const policies of [
      [
        { max: 30, count: 1, reset: 60 },
        { max: 480, count: 1, reset: 60 },
      ],
      [
        { max: 30, count: 1, reset: 60 },
        { max: 480, count: 470, reset: 60 },
      ],
      [
        { max: 30, count: 20, reset: 60 },
        { max: 480, count: 470, reset: 30 },
      ],
    ]) {
      const expected = policies
        .toSorted(
          (left, right) =>
            left.max - left.count - (right.max - right.count) ||
            left.reset - right.reset,
        )
        .at(0);
      if (expected === undefined) {
        panic("Missing test policy");
      }
      for (const ordered of [policies, policies.toReversed()]) {
        let app = new Elysia();
        for (const policy of ordered) {
          app = app.use(
            rateLimit({
              max: policy.max,
              duration: 60_000,
              generator: () => "fixture",
              context: {
                init: () => undefined,
                decrement: () => undefined,
                kill: () => undefined,
                increment: (_key, _duration, requestTime = 0) => ({
                  count: policy.count,
                  start: requestTime,
                  nextReset: new Date(requestTime + policy.reset * 1000),
                }),
              },
            }),
          );
        }
        const response = await app
          .get("/policies", () => "ok")
          .handle(new Request("http://localhost/policies"));
        expect(response.status).toBe(200);
        expect(response.headers.get("RateLimit-Limit")).toBe(
          String(expected.max),
        );
        expect(response.headers.get("RateLimit-Remaining")).toBe(
          String(expected.max - expected.count),
        );
        expect(response.headers.get("RateLimit-Reset")).toBe(
          String(expected.reset),
        );
      }
    }
  });
});
