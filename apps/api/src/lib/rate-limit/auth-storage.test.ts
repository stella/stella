import { beforeEach, describe, expect, test } from "bun:test";

import { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";

let redisDown = false;
let commandLatencyMs = 0;
let invalidResponse = false;
const redisCounters = new Map<string, { count: number; expiresAt: number }>();

class FakeRedisClient {
  async send(
    command: "EVAL",
    args: [string, "1", string, string, string],
  ): Promise<unknown> {
    if (redisDown) {
      throw new Error("redis unreachable");
    }
    expect(command).toBe("EVAL");
    const key = args[2];
    const windowMs = Number(args[3]);
    const max = Number(args[4]);
    const now = Date.now();
    const existing = redisCounters.get(key);
    const entry =
      existing && existing.expiresAt > now
        ? existing
        : { count: 0, expiresAt: now + windowMs };
    entry.count += 1;
    redisCounters.set(key, entry);
    const result = invalidResponse
      ? { invalid: true }
      : [
          entry.count <= max ? 1 : 0,
          Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)),
        ];
    if (commandLatencyMs === 0) {
      return result;
    }
    return await new Promise((resolve) => {
      setTimeout(() => resolve(result), commandLatencyMs);
    });
  }
}

const createStorage = () =>
  createAuthRateLimitStorage({ redis: new FakeRedisClient() });

const RULE = { max: 3, window: 60 } as const;

describe("auth rate-limit storage", () => {
  beforeEach(() => {
    redisDown = false;
    commandLatencyMs = 0;
    invalidResponse = false;
    redisCounters.clear();
  });

  test("atomically consumes the Redis budget and returns retry timing", async () => {
    const storage = createStorage();

    expect(await storage.consume("ip:1.2.3.4", RULE)).toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(await storage.consume("ip:1.2.3.4", RULE)).toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(await storage.consume("ip:1.2.3.4", RULE)).toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(await storage.consume("ip:1.2.3.4", RULE)).toEqual({
      allowed: false,
      retryAfter: 60,
    });
  });

  test("admits exactly the configured number under concurrent load", async () => {
    const storage = createStorage();
    const decisions = await Promise.all(
      Array.from(
        { length: 20 },
        async () => await storage.consume("ip:concurrent", RULE),
      ),
    );

    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(RULE.max);
    expect(decisions.filter(({ allowed }) => !allowed)).toHaveLength(
      20 - RULE.max,
    );
  });

  test("fails open to a bounded per-process counter during an outage", async () => {
    const storage = createStorage();
    redisDown = true;

    expect(await storage.consume("ip:outage", RULE)).toMatchObject({
      allowed: true,
    });
    expect(await storage.consume("ip:outage", RULE)).toMatchObject({
      allowed: true,
    });
    expect(await storage.consume("ip:outage", RULE)).toMatchObject({
      allowed: true,
    });
    expect(await storage.consume("ip:outage", RULE)).toMatchObject({
      allowed: false,
    });
  });

  test("keeps the fallback warm before Redis becomes unavailable", async () => {
    const storage = createStorage();

    await storage.consume("ip:warm", RULE);
    await storage.consume("ip:warm", RULE);
    redisDown = true;

    expect(await storage.consume("ip:warm", RULE)).toMatchObject({
      allowed: true,
    });
    expect(await storage.consume("ip:warm", RULE)).toMatchObject({
      allowed: false,
    });
  });

  test("uses the bounded fallback when Redis returns an invalid response", async () => {
    const storage = createStorage();
    invalidResponse = true;

    await storage.consume("ip:invalid", { max: 1, window: 60 });
    expect(
      await storage.consume("ip:invalid", { max: 1, window: 60 }),
    ).toMatchObject({ allowed: false });
  });

  test("falls back within a bounded time when a Redis command hangs", async () => {
    const storage = createStorage();
    await storage.consume("ip:slow", RULE);
    commandLatencyMs = 5000;

    const start = Date.now();
    const decision = await storage.consume("ip:slow", RULE);

    expect(decision).toMatchObject({ allowed: true });
    expect(Date.now() - start).toBeLessThan(1500);
  });

  test("clears command timeout timers after Redis resolves", async () => {
    let activeTimerCount = 0;
    const storage = createAuthRateLimitStorage({
      redis: new FakeRedisClient(),
      commandTimer: {
        set: (callback, delayMs) => {
          activeTimerCount += 1;
          return setTimeout(callback, delayMs);
        },
        clear: (timeoutId) => {
          clearTimeout(timeoutId);
          activeTimerCount -= 1;
        },
      },
    });

    await storage.consume("ip:timer", RULE);

    expect(activeTimerCount).toBe(0);
  });
});
