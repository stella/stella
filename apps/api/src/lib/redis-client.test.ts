import { describe, expect, mock, test } from "bun:test";

const createBunRedisClientCalls: unknown[] = [];

void mock.module("bullmq", () => ({
  createBunRedisClient: (...args: unknown[]) => {
    createBunRedisClientCalls.push(args);
    return { connect: async () => undefined };
  },
}));

const { connectWithColdStartRetries, createBullMqConnection } =
  await import("@/api/lib/redis-client");

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

describe("connectWithColdStartRetries", () => {
  test("resolves once a transient cold-start failure recovers", async () => {
    let calls = 0;
    const connectOnce = async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      }
    };

    // Resolving without throwing is the assertion; a rejection fails the test.
    await connectWithColdStartRetries(connectOnce);
    expect(calls).toBe(3);
  });

  test("rethrows the original error once retries are exhausted", async () => {
    const originalError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const connectOnce = async () => {
      throw originalError;
    };

    let caught: unknown;
    try {
      await connectWithColdStartRetries(connectOnce);
    } catch (error) {
      caught = error;
    }
    // Identity check: the retries-exhausted rethrow must preserve the
    // original error object, not wrap it.
    expect(caught).toBe(originalError);
  });
});
