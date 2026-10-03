import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  createStorePolicy,
  StoreUnavailableError,
  type StorePolicyStatus,
} from "./store-policy";

for (const reported of [
  "allkeys-lru",
  "allkeys-lfu",
  "volatile-lru",
  "volatile-lfu",
  "allkeys-random",
  "volatile-random",
  "volatile-ttl",
]) {
  test(`durable coordination refuses ${reported}`, async () => {
    const observed: StorePolicyStatus[] = [];
    const policy = createStorePolicy({
      storeClass: "durable-coordination",
      inspect: async () => `# Memory\r\nmaxmemory_policy:${reported}\r\n`,
      observe: (status) => {
        observed.push(status);
      },
    });
    const refused1 = await Result.tryPromise({
      try: async () => {
        await policy.assertAllowed();
      },
      catch: (error: unknown) => error,
    });
    expect(refused1.isErr()).toBe(true);
    if (refused1.isErr()) {
      expect(refused1.error).toBeInstanceOf(StoreUnavailableError);
    }
    const refused2 = await Result.tryPromise({
      try: async () => {
        await policy.assertAllowed();
      },
      catch: (error: unknown) => error,
    });
    expect(refused2.isErr()).toBe(true);
    if (refused2.isErr()) {
      expect(refused2.error).toMatchObject({
        reason: "unavailable",
      });
    }
    expect(observed).toEqual(["refused"]);
  });
}

test("cache commands never inspect or refuse a store", async () => {
  let inspected = 0;
  const observed: StorePolicyStatus[] = [];
  const policy = createStorePolicy({
    storeClass: "cache",
    inspect: async () => {
      inspected += 1;
      return "maxmemory_policy:allkeys-lru\r\n";
    },
    observe: (status) => {
      observed.push(status);
    },
  });
  await policy.assertAllowed();
  policy.invalidate();
  await policy.assertAllowed();
  expect(inspected).toBe(0);
  expect(observed).toEqual([]);
});

test("one inspection serves concurrent operations and refreshes after reconnect or a minute", async () => {
  let now = 0;
  let reported = "noeviction";
  let inspected = 0;
  const observed: StorePolicyStatus[] = [];
  const policy = createStorePolicy({
    storeClass: "durable-coordination",
    now: () => now,
    inspect: async () => {
      inspected += 1;
      return `maxmemory_policy:${reported}\r\n`;
    },
    observe: (status) => {
      observed.push(status);
    },
  });
  await Promise.all(
    Array.from({ length: 20 }, async () => await policy.assertAllowed()),
  );
  expect(inspected).toBe(1);
  reported = "allkeys-lru";
  now = 59_999;
  await policy.assertAllowed();
  expect(inspected).toBe(1);
  now = 60_000;
  const refused3 = await Result.tryPromise({
    try: async () => {
      await policy.assertAllowed();
    },
    catch: (error: unknown) => error,
  });
  expect(refused3.isErr()).toBe(true);
  if (refused3.isErr()) {
    expect(refused3.error).toBeInstanceOf(StoreUnavailableError);
  }
  reported = "noeviction";
  policy.invalidate();
  await policy.assertAllowed();
  expect(inspected).toBe(3);
  expect(observed).toEqual(["allowed", "refused", "allowed"]);
});

for (const reply of [undefined, 5, "# Memory\r\n", "maxmemory_policy:\r\n"]) {
  test(`unknown policy remains available: ${String(reply)}`, async () => {
    const observed: StorePolicyStatus[] = [];
    const policy = createStorePolicy({
      storeClass: "durable-coordination",
      inspect: async () => reply,
      observe: (status) => {
        observed.push(status);
      },
    });
    await policy.assertAllowed();
    expect(observed).toEqual(["unknown"]);
  });
}

test("inspection errors and timeouts remain available and emit unknown", async () => {
  for (const inspect of [
    async () =>
      await Promise.reject(
        new StoreUnavailableError({
          message: "INFO denied",
          reason: "unavailable",
        }),
      ),
    async () => await new Promise<never>(() => {}),
  ]) {
    const observed: StorePolicyStatus[] = [];
    const policy = createStorePolicy({
      storeClass: "durable-coordination",
      inspect,
      observe: (status) => {
        observed.push(status);
      },
    });
    await policy.assertAllowed();
    expect(observed).toEqual(["unknown"]);
  }
});

test("an unknown refreshed policy permits operations after a refusal", async () => {
  let reply = "maxmemory_policy:allkeys-lru\r\n";
  const policy = createStorePolicy({
    storeClass: "durable-coordination",
    inspect: async () => reply,
    observe: () => {},
  });
  const refused4 = await Result.tryPromise({
    try: async () => {
      await policy.assertAllowed();
    },
    catch: (error: unknown) => error,
  });
  expect(refused4.isErr()).toBe(true);
  if (refused4.isErr()) {
    expect(refused4.error).toBeInstanceOf(StoreUnavailableError);
  }
  reply = "# Memory\r\n";
  policy.invalidate();
  await policy.assertAllowed();
});

test("a reconnect during inspection waits for the replacement policy", async () => {
  const first = Promise.withResolvers<unknown>();
  let inspections = 0;
  const observed: StorePolicyStatus[] = [];
  const policy = createStorePolicy({
    storeClass: "durable-coordination",
    inspect: async () => {
      inspections += 1;
      return inspections === 1
        ? await first.promise
        : "maxmemory_policy:allkeys-lru\r\n";
    },
    observe: (status) => {
      observed.push(status);
    },
  });
  const operation = policy.assertAllowed();
  policy.invalidate();
  first.resolve("maxmemory_policy:noeviction\r\n");
  const refused5 = await Result.tryPromise({
    try: async () => {
      await operation;
    },
    catch: (error: unknown) => error,
  });
  expect(refused5.isErr()).toBe(true);
  if (refused5.isErr()) {
    expect(refused5.error).toBeInstanceOf(StoreUnavailableError);
  }
  expect(inspections).toBe(2);
  expect(observed).toEqual(["refused"]);
});
