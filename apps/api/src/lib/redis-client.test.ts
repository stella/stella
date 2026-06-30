import { describe, expect, mock, test } from "bun:test";

const createBunRedisClientCalls: unknown[] = [];

void mock.module("bullmq", () => ({
  createBunRedisClient: (...args: unknown[]) => {
    createBunRedisClientCalls.push(args);
    return {};
  },
}));

const { createBullMqConnection } = await import("@/api/lib/redis-client");

describe("BullMQ Redis connection", () => {
  test("lets BullMQ own connection startup", () => {
    createBunRedisClientCalls.length = 0;

    createBullMqConnection();

    expect(createBunRedisClientCalls).toHaveLength(1);
    expect(createBunRedisClientCalls[0]).toMatchObject([
      expect.anything(),
      { lazyConnect: true },
    ]);
  });
});
