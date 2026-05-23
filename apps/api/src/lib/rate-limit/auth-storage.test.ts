import { beforeEach, describe, expect, mock, test } from "bun:test";

// A controllable fake of ioredis: `redisDown` toggles whether get/set
// reject, simulating an unreachable Redis without real I/O.
let redisDown = false;
const redisStore = new Map<string, string>();
const redisConstructorOptions: unknown[] = [];

class FakeRedis {
  constructor(_url: string, options: unknown) {
    redisConstructorOptions.push(options);
  }

  on(): this {
    return this;
  }

  async get(key: string): Promise<string | null> {
    if (redisDown) {
      throw new Error("redis unreachable");
    }
    return redisStore.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    if (redisDown) {
      throw new Error("redis unreachable");
    }
    redisStore.set(key, value);
    return "OK";
  }
}

void mock.module("ioredis", () => ({ default: FakeRedis }));

const { createAuthRateLimitStorage } =
  await import("@/api/lib/rate-limit/auth-storage");

const value = (count: number) => ({
  key: "ip:1.2.3.4",
  count,
  lastRequest: 1000,
});

describe("auth rate-limit storage", () => {
  beforeEach(() => {
    redisDown = false;
    redisStore.clear();
    redisConstructorOptions.length = 0;
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

  test("configures Redis commands to fail fast", () => {
    createAuthRateLimitStorage(60_000);

    expect(redisConstructorOptions.at(0)).toMatchObject({
      commandTimeout: 500,
      connectTimeout: 500,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
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
});
