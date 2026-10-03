import { Result } from "better-result";
import { RedisClient } from "bun";
import { expect, spyOn, test } from "bun:test";

import { StoreUnavailableError } from "@stll/redis-config/store-policy";

import { createFeedbackIntakeGuards } from "@/api/handlers/feedback/intake-guards";
import { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";
import {
  createBullMqConnection,
  createRedisClient,
} from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";
import { createMcpGatewayRateLimiter } from "@/api/mcp/gateway/rate-limit";

const expectStoreRefusal = async (command: Promise<unknown>) => {
  const result = await Result.tryPromise({
    try: async () => await command,
    catch: (error: unknown) => error,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toBeInstanceOf(StoreUnavailableError);
  }
};

const key = coordinationKey({
  scope: "security-canary",
  slot: "test",
  suffix: "store-policy-test:v1",
});

const withReportedPolicy = async (run: (sent: string[]) => Promise<void>) => {
  const sent: string[] = [];
  const connect = spyOn(RedisClient.prototype, "connect").mockResolvedValue(
    undefined,
  );
  const send = spyOn(RedisClient.prototype, "send").mockImplementation(
    async (command) => {
      sent.push(command);
      return command === "INFO" ? "maxmemory_policy:allkeys-lru\r\n" : "OK";
    },
  );
  const get = spyOn(RedisClient.prototype, "get").mockResolvedValue("value");
  try {
    await run(sent);
  } finally {
    connect.mockRestore();
    send.mockRestore();
    get.mockRestore();
  }
};

test("durable native methods, connection startup and duplicate clients require the policy", async () => {
  await withReportedPolicy(async (sent) => {
    const client = createRedisClient({ storeClass: "durable-coordination" });
    const clone = await client.duplicate();
    try {
      await expectStoreRefusal(client.connect());
      await expectStoreRefusal(client.send("EVAL", ["return 1", "1", key]));
      await expectStoreRefusal(client.get(key));
      await expectStoreRefusal(clone.send("PING", []));
      expect(sent).toEqual(["INFO", "INFO"]);
    } finally {
      client.close();
      clone.close();
    }
  });
});

test("cache native commands and duplicates remain available", async () => {
  await withReportedPolicy(async (sent) => {
    const client = createRedisClient({ storeClass: "cache" });
    const clone = await client.duplicate();
    try {
      expect(await client.get(key)).toBe("value");
      expect(await clone.send("PING", [])).toBe("OK");
      expect(sent).toEqual(["PING"]);
    } finally {
      client.close();
      clone.close();
    }
  });
});

test("BullMQ refuses startup and enqueue commands through its classified raw client", async () => {
  await withReportedPolicy(async (sent) => {
    const connection = createBullMqConnection({
      storeClass: "durable-coordination",
    });
    try {
      await expectStoreRefusal(connection.connect());
      connection.defineCommand("policyTest", {
        numberOfKeys: 1,
        lua: "return 1",
      });
      await expectStoreRefusal(connection.runCommand("policyTest", [key]));
      expect(sent.every((command) => command === "INFO")).toBe(true);
      expect(sent.length).toBeGreaterThan(0);
    } finally {
      connection.disconnect();
    }
  });
});

for (const failurePolicy of ["fail_open_local", "fail_closed"] as const) {
  test(`a refused store retains the rate limiter's ${failurePolicy} policy`, async () => {
    await withReportedPolicy(async (sent) => {
      const errors: unknown[] = [];
      const context = new RedisRateLimitContext({
        failurePolicy,
        onRedisError: (error) => errors.push(error),
      });
      try {
        const counter = await context.increment("store-policy-test");
        expect(counter.count).toBe(
          failurePolicy === "fail_open_local" ? 1 : Number.MAX_SAFE_INTEGER,
        );
        expect(
          errors.some((error) => error instanceof StoreUnavailableError),
        ).toBe(true);
        expect(sent).toEqual(["INFO"]);
      } finally {
        context.kill();
      }
    });
  });
}

test("auth, gateway and feedback rate limiters keep local fallback on a refused policy", async () => {
  await withReportedPolicy(async (sent) => {
    const auth = createAuthRateLimitStorage();
    expect(
      await auth.consume("policy-test", { max: 1, window: 60 }),
    ).toMatchObject({ allowed: true });
    expect(
      await auth.consume("policy-test", { max: 1, window: 60 }),
    ).toMatchObject({ allowed: false });
    const gateway = createMcpGatewayRateLimiter();
    expect(
      await gateway.consume({
        connectorSlug: "policy-test",
        userId: "user-test",
      }),
    ).toBe(true);
    const feedback = createFeedbackIntakeGuards();
    expect(
      await feedback.consumeCounter({
        bucket: "policy-test",
        key: "user-test",
        max: 1,
        windowMs: 60_000,
      }),
    ).toBe(true);
    expect(
      await feedback.consumeCounter({
        bucket: "policy-test",
        key: "user-test",
        max: 1,
        windowMs: 60_000,
      }),
    ).toBe(false);
    expect(sent).toEqual(["INFO", "INFO", "INFO"]);
  });
});
