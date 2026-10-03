import { Result } from "better-result";
import { Queue, Worker } from "bullmq";
import { RedisClient } from "bun";
import { describe, expect, spyOn, test } from "bun:test";

import { StoreUnavailableError } from "@stll/redis-config/store-policy";

import {
  createBullMqConnection,
  createRedisClient,
} from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";

const enabled = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";

describe.skipIf(!enabled)("classified clients over Valkey", () => {
  test("native commands, BullMQ producers and workers enforce the inspected policy", async () => {
    const key = coordinationKey({
      scope: "security-canary",
      slot: Bun.randomUUIDv7(),
      suffix: "store-policy-test:v1",
    });
    const cache = createRedisClient({ storeClass: "cache" });
    await cache.connect();
    expect(await cache.send("PING", [])).toBe("PONG");
    const originalSend = RedisClient.prototype.send;
    let reported = "noeviction";
    const inspect = spyOn(RedisClient.prototype, "send").mockImplementation(
      async function (this: RedisClient, command, args) {
        const reply: unknown = await originalSend.call(this, command, args);
        if (command === "INFO" && typeof reply === "string") {
          expect(reply).toContain("maxmemory_policy:");
          return reply.replace(
            /^maxmemory_policy:[^\r\n]+/mu,
            () => `maxmemory_policy:${reported}`,
          );
        }
        return reply;
      },
    );
    const allowed = createRedisClient({ storeClass: "durable-coordination" });
    const refused = createRedisClient({ storeClass: "durable-coordination" });
    const clone = await refused.duplicate();
    const queueConnection = createBullMqConnection({
      storeClass: "durable-coordination",
    });
    const workerConnection = createBullMqConnection({
      storeClass: "durable-coordination",
    });
    // Native get/set bypass send internally; the factory must guard them too.
    await allowed.set(key, "allowed");
    expect(await allowed.get(key)).toBe("allowed");
    reported = "allkeys-lru";
    const queue = new Queue(`store-policy-${Bun.randomUUIDv7()}`, {
      connection: queueConnection,
    });
    let executed = 0;
    const worker = new Worker(
      queue.name,
      async () => {
        executed += 1;
      },
      { connection: workerConnection, autorun: false },
    );
    const errors: unknown[] = [];
    queue.on("error", (error) => errors.push(error));
    worker.on("error", (error) => errors.push(error));
    try {
      await cache.set(key, "cache");
      await expect(refused.set(key, "refused")).rejects.toBeInstanceOf(
        StoreUnavailableError,
      );
      await expect(clone.get(key)).rejects.toBeInstanceOf(
        StoreUnavailableError,
      );
      expect(await cache.get(key)).toBe("cache");
      await expect(queue.add("policy", {})).rejects.toBeInstanceOf(
        StoreUnavailableError,
      );
      await expect(worker.waitUntilReady()).rejects.toBeInstanceOf(
        StoreUnavailableError,
      );
      expect(executed).toBe(0);
    } finally {
      // A refused readiness promise is also returned by BullMQ close.
      const closures = await Promise.all([
        Result.tryPromise(() => queue.close()),
        Result.tryPromise(() => worker.close(true)),
      ]);
      for (const closure of closures) {
        if (Result.isError(closure)) {
          expect(closure.error).toBeInstanceOf(StoreUnavailableError);
        }
      }
      queueConnection.disconnect();
      workerConnection.disconnect();
      allowed.close();
      refused.close();
      clone.close();
      inspect.mockRestore();
      await cache.del(key);
      cache.close();
    }
  });
});
