import { describe, expect, mock, spyOn, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

type FakeRedisClient = {
  subscribe: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
};

const createdClients: FakeRedisClient[] = [];
let subscribeBehavior: "reject" | "resolve" = "resolve";

const makeFakeRedisClient = (): FakeRedisClient => {
  const client: FakeRedisClient = {
    subscribe: mock(async () => {
      if (subscribeBehavior === "reject") {
        throw new Error("redis unavailable");
      }
    }),
    publish: mock(async () => undefined),
    close: mock(() => undefined),
  };
  createdClients.push(client);
  return client;
};

const createRedisClientMock = mock(() => makeFakeRedisClient());

void mock.module("@/api/lib/redis-client", () => ({
  createRedisClient: createRedisClientMock,
}));

// setInterval/clearInterval are spied (not replaced) so startSse/stopSse
// still schedule and clear a real timer; the spies only let the tests
// observe whether the module called them, matching how sse.ts calls the
// global functions directly.
const setIntervalSpy = spyOn(globalThis, "setInterval");
const clearIntervalSpy = spyOn(globalThis, "clearInterval");

const { broadcast, startSse, stopSse, subscribe } =
  await import("@/api/lib/sse");

// Let the fire-and-forget subscribe promise inside startSse settle.
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const workspaceId = toSafeId<"workspace">("ws_1");
const organizationId = toSafeId<"organization">("org_1");

describe("sse module import", () => {
  test("importing the module opens no Redis connection and starts no timer", () => {
    expect(createdClients).toHaveLength(0);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(createRedisClientMock).not.toHaveBeenCalled();
  });

  test("registering a local connection before startSse does not throw", () => {
    const controller = new AbortController();

    expect(() =>
      subscribe(workspaceId, organizationId, controller.signal),
    ).not.toThrow();

    controller.abort();
  });

  test("broadcasting before startSse does not throw", async () => {
    expect(() =>
      broadcast(workspaceId, { type: "test-event", data: null }),
    ).not.toThrow();

    await flushMicrotasks();
  });
});

describe("startSse / stopSse lifecycle", () => {
  test("startSse starts the keep-alive timer and connects the Redis subscriber", async () => {
    setIntervalSpy.mockClear();
    createdClients.length = 0;

    startSse();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await flushMicrotasks();

    expect(createdClients).toHaveLength(1);
    expect(createdClients[0]?.subscribe).toHaveBeenCalledTimes(1);

    stopSse();
    await flushMicrotasks();
  });

  test("startSse is idempotent: repeated calls create only one timer and one subscriber", async () => {
    setIntervalSpy.mockClear();
    createdClients.length = 0;

    startSse();
    startSse();
    startSse();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await flushMicrotasks();

    expect(createdClients).toHaveLength(1);

    stopSse();
    await flushMicrotasks();
  });

  test("stopSse clears the interval and closes the subscriber", async () => {
    clearIntervalSpy.mockClear();
    createdClients.length = 0;

    startSse();
    await flushMicrotasks();

    const client = createdClients[0];
    expect(client).toBeDefined();

    stopSse();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(client?.close).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
  });

  test("stopSse is safe when startSse was never called", () => {
    expect(() => stopSse()).not.toThrow();
  });

  test("stopSse is safe when called more than once", async () => {
    createdClients.length = 0;

    startSse();
    await flushMicrotasks();

    stopSse();
    expect(() => stopSse()).not.toThrow();

    await flushMicrotasks();
  });

  test("a Redis connection failure during startSse is logged and does not throw", async () => {
    subscribeBehavior = "reject";
    createdClients.length = 0;

    expect(() => startSse()).not.toThrow();

    await flushMicrotasks();

    // The client created for the failed connection attempt is still
    // closed, so a repeated failure does not leak a raw client handle.
    expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);

    stopSse();
    await flushMicrotasks();
    subscribeBehavior = "resolve";
  });

  test("stopping before the in-flight Redis connection resolves closes it instead of leaking it", async () => {
    createdClients.length = 0;

    startSse();
    // stopSse runs before the mocked subscribe() promise has settled.
    stopSse();

    await flushMicrotasks();

    expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
  });

  test("a stop+restart during connect does not attach the old subscriber to the new lifecycle", async () => {
    createdClients.length = 0;

    startSse();
    stopSse();
    // The first connection attempt is still in flight (its subscribe()
    // promise has not settled) when a new lifecycle starts.
    startSse();

    await flushMicrotasks();

    expect(createdClients).toHaveLength(2);
    const [oldClient, newClient] = createdClients;

    // The stale connection recognizes it no longer belongs to the active
    // lifecycle and closes itself instead of attaching to the new one.
    expect(oldClient?.close).toHaveBeenCalledTimes(1);
    expect(newClient?.close).not.toHaveBeenCalled();

    // The new lifecycle's subscriber is the one actually attached:
    // stopping it now closes newClient exactly once.
    stopSse();
    expect(newClient?.close).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
  });
});
