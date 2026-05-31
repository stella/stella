import { beforeEach, describe, expect, mock, test, vi } from "bun:test";

// A controllable fake of Bun's RedisClient: `redisDown` toggles whether
// get/set reject, simulating an unreachable Redis without real I/O.
// `commandLatencyMs` makes commands hang for the test, exercising the
// per-command timeout that auth-storage layers on top of the client.
let redisDown = false;
let commandLatencyMs = 0;
const redisStore = new Map<string, string>();

class FakeRedisClient {
  onclose: ((error: Error) => void) | null = null;
  onconnect: (() => void) | null = null;

  private async maybeDelay<T>(value: T): Promise<T> {
    if (commandLatencyMs > 0) {
      return new Promise<T>((resolve) => {
        setTimeout(() => {
          resolve(value);
        }, commandLatencyMs);
      });
    }
    return value;
  }

  async get(key: string): Promise<string | null> {
    if (redisDown) {
      throw new Error("redis unreachable");
    }
    return this.maybeDelay(redisStore.get(key) ?? null);
  }

  async set(key: string, value: string): Promise<"OK"> {
    if (redisDown) {
      throw new Error("redis unreachable");
    }
    redisStore.set(key, value);
    return this.maybeDelay("OK" as const);
  }
}

void mock.module("@/api/lib/redis-client", () => ({
  createRedisClient: () => new FakeRedisClient(),
}));

const { createAuthRateLimitStorage } =
  await import("@/api/lib/rate-limit/auth-storage");

const value = (count: number, lastRequest = 1000) => ({
  key: "ip:1.2.3.4",
  count,
  lastRequest,
});

describe("auth rate-limit storage", () => {
  beforeEach(() => {
    redisDown = false;
    commandLatencyMs = 0;
    redisStore.clear();
  });

  test("round-trips through Redis when it is reachable", async () => {
    const storage = createAuthRateLimitStorage(60_000);

    await storage.set("ip:1.2.3.4", value(3));

    expect(await storage.get("ip:1.2.3.4")).toEqual(value(3));
  });

  test("returns null for an unknown key", async () => {
    const storage = createAuthRateLimitStorage(60_000);

    expect(await storage.get("ip:9.9.9.9")).toBeNull();
  });

  test("fails open: a get after Redis goes down reads the fallback", async () => {
    const storage = createAuthRateLimitStorage(60_000);

    // A successful set warms both Redis and the in-memory fallback.
    await storage.set("ip:1.2.3.4", value(5));
    redisDown = true;

    // Redis get throws; the storage must still return the counter so a
    // Redis outage degrades to per-instance limiting, not a hard lock.
    expect(await storage.get("ip:1.2.3.4")).toEqual(value(5));
  });

  test("fails open: set never throws when Redis is down", async () => {
    const storage = createAuthRateLimitStorage(60_000);
    redisDown = true;

    // set must resolve (not reject) even though the Redis write fails.
    await storage.set("ip:1.2.3.4", value(2));

    // The fallback was still written, so a subsequent get resolves it.
    expect(await storage.get("ip:1.2.3.4")).toEqual(value(2));
  });

  test("falls back when Redis is reachable but missing a warmed key", async () => {
    const storage = createAuthRateLimitStorage(60_000);
    redisDown = true;

    await storage.set("ip:1.2.3.4", value(4));
    redisDown = false;

    expect(await storage.get("ip:1.2.3.4")).toEqual(value(4));
  });

  test("stores fallback values as snapshots", async () => {
    const storage = createAuthRateLimitStorage(60_000);
    const counter = value(7);

    await storage.set("ip:1.2.3.4", counter);
    counter.count = 99;
    redisDown = true;

    expect(await storage.get("ip:1.2.3.4")).toEqual(value(7));
  });

  test("keeps the stricter fallback counter when Redis has stale data", async () => {
    const storage = createAuthRateLimitStorage(60_000);

    await storage.set("ip:1.2.3.4", value(5, 1000));
    redisDown = true;
    await storage.set("ip:1.2.3.4", value(6, 2000));
    redisDown = false;

    expect(await storage.get("ip:1.2.3.4")).toEqual(value(6, 2000));
    expect(redisStore.get("auth:ratelimit:ip:1.2.3.4")).toBe(
      JSON.stringify(value(6, 2000)),
    );
  });

  test("fails open when a Redis command hangs past the timeout", async () => {
    const storage = createAuthRateLimitStorage(60_000);

    // Warm the fallback.
    await storage.set("ip:1.2.3.4", value(8));

    // Now make Redis "hang" — get() will not resolve. The per-command
    // timeout must reject internally and the storage must surface the
    // fallback value within a bounded window.
    commandLatencyMs = 5000;
    const start = Date.now();
    const result = await storage.get("ip:1.2.3.4");
    const elapsed = Date.now() - start;

    expect(result).toEqual(value(8));
    // 500ms timeout + scheduler slack. If this fails, the timeout
    // wrapper has regressed and auth could hang on a slow Redis.
    expect(elapsed).toBeLessThan(1500);
  });

  test("clears command timeout timers after Redis resolves", async () => {
    vi.useFakeTimers();
    try {
      const storage = createAuthRateLimitStorage(60_000);
      const baselineTimers = vi.getTimerCount();

      await storage.set("ip:1.2.3.4", value(9));

      expect(vi.getTimerCount()).toBe(baselineTimers);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
