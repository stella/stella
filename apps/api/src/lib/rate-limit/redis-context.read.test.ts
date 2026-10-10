import { expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import {
  createRedisRateLimitRequestKey,
  RedisRateLimitContext,
} from "@/api/lib/rate-limit/redis-context";

test("counter reads preserve quota and ignore expired local windows", () => {
  const context = new InMemoryRateLimitContext();
  context.init({ duration: 60_000 });
  try {
    expect(context.read("unused")).toBeNull();
    const original = context.increment("active");
    expect(context.read("active")).toEqual(original);
    expect(context.read("active")).toEqual(original);
    expect(context.increment("active").count).toBe(2);
    context.increment(
      "expired",
      1,
      Temporal.Now.instant().epochMilliseconds - 100,
    );
    expect(context.read("expired")).toBeNull();
  } finally {
    context.kill();
  }
});

test.each([
  [0, -1],
  [0, 30_000],
  [3, 30_000],
])(
  "Redis counter read accepts count %s and TTL %s without writes",
  async (count, ttl) => {
    const commands: { command: string; args: string[] }[] = [];
    const context = new RedisRateLimitContext({
      failurePolicy: "fail_open_local",
      createRedis: () => ({
        send: async (command, args) => {
          commands.push({ command, args });
          return [count, ttl];
        },
      }),
    });
    context.init({ duration: 60_000 });
    try {
      const key = createRedisRateLimitRequestKey({
        counterKey: "address",
        requestId: "request",
      });
      const observed = await context.read(key);
      if (ttl === -1) {
        expect(observed).toBeNull();
      } else {
        expect(observed?.count).toBe(count);
        expect(observed?.nextReset.getTime()).toBeGreaterThan(
          Temporal.Now.instant().epochMilliseconds,
        );
      }
      await context.complete(key);
      expect(commands).toHaveLength(1);
      const read = commands.at(0);
      expect(read?.command).toBe("EVAL");
      expect(read?.args.at(0)).toContain("PTTL");
      expect(read?.args.at(0)).toContain("HGET");
      expect(read?.args.at(0)).not.toMatch(/HINCRBY|HSET|PEXPIRE|HDEL/u);
      expect(read?.args.at(2)).not.toContain("request");
    } finally {
      await context.kill();
    }
  },
);

test.each(["fail_open_local", "fail_closed"] as const)(
  "failed counter reads preserve the %s outage policy",
  async (failurePolicy) => {
    const operations: string[] = [];
    const context = new RedisRateLimitContext({
      failurePolicy,
      createRedis: () => ({
        send: async () => {
          throw new TypeError("unavailable");
        },
      }),
      onRedisError: (_error, operation) => operations.push(operation),
    });
    context.init({ duration: 60_000 });
    try {
      const empty = await context.read("address");
      expect(operations).toEqual(["read"]);
      if (failurePolicy === "fail_open_local") {
        expect(empty).toBeNull();
        await context.increment("address");
        expect((await context.read("address"))?.count).toBe(1);
        expect((await context.read("address"))?.count).toBe(1);
      } else {
        expect(empty?.count).toBe(Number.MAX_SAFE_INTEGER);
      }
    } finally {
      await context.kill();
    }
  },
);
