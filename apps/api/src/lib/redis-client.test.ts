import { describe, expect, mock, test } from "bun:test";

const createBunRedisClientCalls: unknown[] = [];

// Spread the real module: mock.module is process-global; a partial mock would
// delete bullmq's other exports for later test files.
const realBullmq = await import("bullmq");
void mock.module("bullmq", () => ({
  ...realBullmq,
  createBunRedisClient: (...args: unknown[]) => {
    createBunRedisClientCalls.push(args);
    return { connect: async () => undefined };
  },
}));

const {
  connectWithColdStartRetries,
  createBullMqConnection,
  createLazyRedisClient,
  isRecoverableRedisPollError,
} = await import("@/api/lib/redis-client");

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

describe("isRecoverableRedisPollError", () => {
  const withCode = (code: string): Error =>
    Object.assign(new Error(code), { code });

  test("classifies the Bun-adapter poll blip as recoverable", () => {
    expect(
      isRecoverableRedisPollError(withCode("ERR_REDIS_INVALID_RESPONSE")),
    ).toBe(true);
  });

  test("leaves any other error to surface loudly", () => {
    // A real outage (wrong code) and a message-only lookalike must NOT be
    // downgraded, or a genuine failure would be silenced.
    expect(isRecoverableRedisPollError(withCode("ECONNREFUSED"))).toBe(false);
    expect(isRecoverableRedisPollError(new Error("Failed to read data"))).toBe(
      false,
    );
  });

  test("never matches non-Error values", () => {
    expect(isRecoverableRedisPollError("ERR_REDIS_INVALID_RESPONSE")).toBe(
      false,
    );
    expect(isRecoverableRedisPollError(undefined)).toBe(false);
    expect(
      isRecoverableRedisPollError({ code: "ERR_REDIS_INVALID_RESPONSE" }),
    ).toBe(false);
  });
});

/**
 * The class these pin: a client handed out before it is connected, or
 * after it has been closed, turns a cold start or an ordinary shutdown
 * into a command failure at whichever call site happens to be first.
 * Readiness is the client's own property, so these drive it through
 * `ready()` alone.
 */
describe("createLazyRedisClient", () => {
  /** A stand-in for the real client, recording its own lifecycle. */
  const fakeClient = () => {
    const client = {
      close: () => {
        client.closed += 1;
      },
      closed: 0,
      connect: async () => {
        client.connects += 1;
        await client.connectResult();
      },
      connectResult: async () => await Promise.resolve(),
      connects: 0,
    };
    return client;
  };

  test("connects once for however many callers ask", async () => {
    const client = fakeClient();
    const lazy = createLazyRedisClient(() => client);

    const [first, second] = await Promise.all([lazy.ready(), lazy.ready()]);
    await lazy.ready();

    expect(client.connects).toBe(1);
    expect(first).toBe(second);
  });

  test("a caller after an exhausted connect starts a fresh one", async () => {
    // Long enough to outlast the ladder above, so the first caller sees a
    // real failure rather than a retry.
    const failingAttempts = 5;
    const client = fakeClient();
    client.connectResult = async () => {
      if (client.connects <= failingAttempts) {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      }
      await Promise.resolve();
    };
    const lazy = createLazyRedisClient(() => client);

    const rejection: unknown = await lazy.ready().then(
      () => null,
      (error: unknown) => error,
    );
    // Keeping the rejected attempt would strand every later caller behind
    // the outage that has since cleared.
    await lazy.ready();

    expect(rejection).toBeInstanceOf(Error);
    expect(client.connects).toBe(failingAttempts + 1);
  });

  test("closing drops the connection with the client", async () => {
    const clients: ReturnType<typeof fakeClient>[] = [];
    const lazy = createLazyRedisClient(() => {
      const client = fakeClient();
      clients.push(client);
      return client;
    });

    const before = await lazy.ready();
    lazy.close();
    const after = await lazy.ready();

    // A memo that outlived its client would hand the closed one back as
    // connected, and every command after a restart would go into a dead
    // socket.
    expect(after).not.toBe(before);
    expect(clients).toHaveLength(2);
    expect(clients.at(0)?.closed).toBe(1);
    expect(clients.at(1)?.connects).toBe(1);
  });

  test("a caller waiting on a client that gets closed is not handed it", async () => {
    let releaseConnect: () => void = () => undefined;
    const client = fakeClient();
    client.connectResult = async () =>
      await new Promise<void>((resolve) => {
        releaseConnect = resolve;
      });
    const lazy = createLazyRedisClient(() => client);

    const pending = lazy.ready();
    lazy.close();
    releaseConnect();
    const rejection: unknown = await pending.then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({ _tag: "RedisClientClosedError" });
  });
});
