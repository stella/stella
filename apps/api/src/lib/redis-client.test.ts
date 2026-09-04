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
  createRedisClient,
  isRecoverableRedisPollError,
  isTransientRedisConnectionError,
  redisClientOptions,
} = await import("@/api/lib/redis-client");

const REDIS_URL = "redis://127.0.0.1:6379";
// Bun reads `maxRetries` as a u32, so the ceiling is the value rather than an
// arbitrary large number: `Number.MAX_SAFE_INTEGER` is rejected outright.
const U32_CEILING = 4_294_967_295;

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

/**
 * The class these pin: a long-lived client that stops reconnecting is one its
 * holder can never use again, because a closed Bun client cannot be reopened.
 * Both halves have to hold — the ladder must not run out, and the close
 * callback the BullMQ adapter and the holders hang their recovery on has to
 * actually reach Bun's setter.
 */
describe("the reconnect policy", () => {
  test("the reconnect ladder is unbounded", () => {
    expect(redisClientOptions(REDIS_URL).maxRetries).toBe(U32_CEILING);
  });

  test("no call site can reintroduce a bounded ladder", () => {
    const options = redisClientOptions(REDIS_URL, {
      // Type-level half of the same guard: the overrides parameter omits
      // `maxRetries`, so a bounded ladder cannot come back through a caller.
      // @ts-expect-error -- maxRetries is not an override a caller may pass
      maxRetries: 20,
      enableOfflineQueue: false,
    });

    // The policy is applied after the spread, so even a cast past the type
    // does not land.
    expect(options.maxRetries).toBe(U32_CEILING);
    expect(options.enableOfflineQueue).toBe(false);
  });

  test("a fresh client queues its first command until the connection is up", () => {
    // A fresh client connects on its first command. Setting the option here
    // at all would decide for every call site that such a command must be
    // rejected outright, which is how a "create then send" caller (the
    // readiness probe, the SSE subscriber) fails for the length of a
    // handshake it never got to wait for. Leaving it unset keeps Bun's
    // queue-until-connected default.
    expect(redisClientOptions(REDIS_URL)).not.toHaveProperty(
      "enableOfflineQueue",
    );
    // Fail-fast during an outage stays available to the call sites that pair
    // it with a bounded command; `maxRetries` above cannot be overridden.
    expect(
      redisClientOptions(REDIS_URL, { enableOfflineQueue: false })
        .enableOfflineQueue,
    ).toBe(false);
  });

  test("assigning onclose reaches Bun's setter", () => {
    const client = createRedisClient();

    // Through `[[Set]]`, the way BullMQ's adapter registers its own callback.
    Reflect.set(client, "onclose", () => undefined);

    // A class field installs an own data property that shadows the prototype
    // setter, and a callback stored there never fires — which is how BullMQ's
    // adapter would lose the close event it schedules its reconnects on.
    expect(Object.getOwnPropertyDescriptor(client, "onclose")).toBeUndefined();
    client.close();
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

describe("isTransientRedisConnectionError", () => {
  const withCode = (code: string): Error =>
    Object.assign(new Error(code), { code });

  // The classifier gates whether a periodic loop logs a Redis failure as an
  // expected transient or captures it as an exception; a drifted code string
  // would silently disable it, so the exact Bun error codes are pinned. Both
  // mean the command met a connection that was not up: the closed socket the
  // client had already observed, and the connect attempt that had not landed
  // before `connectionTimeout`.
  test.each(["ERR_REDIS_CONNECTION_CLOSED", "ERR_REDIS_CONNECTION_TIMEOUT"])(
    "classifies a %s rejection as transient",
    (code) => {
      expect(isTransientRedisConnectionError(withCode(code))).toBe(true);
    },
  );

  test("leaves other failures and the poll blip unclassified", () => {
    expect(isTransientRedisConnectionError(withCode("ECONNREFUSED"))).toBe(
      false,
    );
    expect(
      isTransientRedisConnectionError(withCode("ERR_REDIS_INVALID_RESPONSE")),
    ).toBe(false);
    expect(isTransientRedisConnectionError(new Error("plain"))).toBe(false);
    expect(isTransientRedisConnectionError("ERR_REDIS_CONNECTION_CLOSED")).toBe(
      false,
    );
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
    const closeHandlers = new Set<() => void>();
    const client = {
      close: () => {
        client.closed += 1;
        client.fireClose();
      },
      closed: 0,
      connect: async () => {
        client.connects += 1;
        await client.connectResult();
      },
      connectResult: async () => await Promise.resolve(),
      connects: 0,
      /** Drive the close callback the way Bun does when a socket ends. */
      fireClose: () => {
        for (const handler of [...closeHandlers]) {
          handler();
        }
      },
      onClose: (handler: () => void) => {
        closeHandlers.add(handler);
        return () => {
          closeHandlers.delete(handler);
        };
      },
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

  test("a lazy client rebuilds after its connection closes", async () => {
    const clients: ReturnType<typeof fakeClient>[] = [];
    const lazy = createLazyRedisClient(() => {
      const client = fakeClient();
      clients.push(client);
      return client;
    });

    const before = await lazy.ready();
    // Nothing closed the holder: the socket ended on its own, and a closed Bun
    // client cannot be reopened.
    before.fireClose();
    const after = await lazy.ready();

    // Keeping the closed client would send every later command here into a
    // socket that never comes back.
    expect(after).not.toBe(before);
    expect(clients).toHaveLength(2);
    expect(clients.at(1)?.connects).toBe(1);
  });

  test("a stale attempt's failure leaves the client that replaced it alone", async () => {
    const clients: ReturnType<typeof fakeClient>[] = [];
    const lazy = createLazyRedisClient(() => {
      const client = fakeClient();
      if (clients.length === 0) {
        // The client that is closed mid-ladder: every attempt fails, so
        // its rejection lands well after its replacement is in place.
        client.connectResult = async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          });
        };
      }
      clients.push(client);
      return client;
    });

    const abandoned = lazy.ready();
    lazy.close();
    const replacement = await lazy.ready();
    await abandoned.then(
      () => null,
      () => null,
    );

    // The abandoned ladder must not clear a memo it no longer owns, or the
    // replacement would connect a second time underneath its own callers.
    expect(await lazy.ready()).toBe(replacement);
    expect(clients).toHaveLength(2);
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
