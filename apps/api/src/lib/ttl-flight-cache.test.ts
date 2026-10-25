import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createTtlFlightCache } from "@/api/lib/ttl-flight-cache";

type Deferred<Value> = ReturnType<typeof Promise.withResolvers<Value>>;

/**
 * A load that counts its runs and settles only when the test says so.
 * `run(index)` resolves once that run has started, which is the cache's own
 * signal: a load starts a microtask after the read that asked for it.
 */
const controlledLoad = <Value>() => {
  const started: Deferred<Deferred<Value>>[] = [];
  const slot = (index: number): Deferred<Deferred<Value>> => {
    started[index] ??= Promise.withResolvers<Deferred<Value>>();
    return started[index];
  };
  let count = 0;
  return {
    load: async (): Promise<Value> => {
      const run = Promise.withResolvers<Value>();
      slot(count).resolve(run);
      count += 1;
      return await run.promise;
    },
    run: async (index: number): Promise<Deferred<Value>> =>
      await slot(index).promise,
    count: () => count,
  };
};

const clock = (start = 1000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const cacheOf = <Value>(
  time: ReturnType<typeof clock>,
  options: { maxEntries?: number; keep?: (value: Value) => boolean } = {},
) =>
  createTtlFlightCache<Value>({
    ttlMs: 60_000,
    maxEntries: options.maxEntries ?? 4,
    now: time.now,
    ...(options.keep === undefined ? {} : { keep: options.keep }),
  });

describe("createTtlFlightCache", () => {
  test("concurrent readers of one key share one load", async () => {
    const cache = cacheOf<string>(clock());
    const loads = controlledLoad<string>();

    const readers = [
      cache.read("POL", loads.load),
      cache.read("POL", loads.load),
      cache.read("POL", loads.load),
    ];
    (await loads.run(0)).resolve("answer");

    expect(await Promise.all(readers)).toEqual(["answer", "answer", "answer"]);
    expect(loads.count()).toBe(1);
  });

  test("a settled answer is served until the window closes, then loaded again", async () => {
    const time = clock();
    const cache = cacheOf<string>(time);
    const loads = controlledLoad<string>();

    const first = cache.read("CZE", loads.load);
    (await loads.run(0)).resolve("first");
    expect(await first).toBe("first");

    time.advance(59_999);
    expect(await cache.read("CZE", loads.load)).toBe("first");
    expect(loads.count()).toBe(1);

    // The window counts from when the load started, not when it settled.
    time.advance(1);
    const second = cache.read("CZE", loads.load);
    (await loads.run(1)).resolve("second");
    expect(await second).toBe("second");
    expect(loads.count()).toBe(2);
  });

  test("keys are answered independently", async () => {
    const cache = cacheOf<string>(clock());
    const loads = controlledLoad<string>();

    const cze = cache.read("CZE", loads.load);
    const svk = cache.read("SVK", loads.load);
    (await loads.run(0)).resolve("cze");
    (await loads.run(1)).resolve("svk");

    expect([await cze, await svk]).toEqual(["cze", "svk"]);
  });

  test("a failed load reaches its waiting readers and is never served again", async () => {
    const cache = cacheOf<string>(clock());
    const loads = controlledLoad<string>();
    const failure = new TypeError("read failed");

    const readers = [
      cache.read("POL", loads.load),
      cache.read("POL", loads.load),
    ];
    const reasons = Promise.all(readers.map(rejectionOf));
    (await loads.run(0)).reject(failure);
    expect(await reasons).toEqual([failure, failure]);

    // Asked again as soon as the failure is answered: no window to wait out.
    const retry = cache.read("POL", loads.load);
    (await loads.run(1)).resolve("recovered");
    expect(await retry).toBe("recovered");
    expect(loads.count()).toBe(2);
  });

  test("an answer keep refuses reaches its readers and is loaded again next time", async () => {
    const cache = cacheOf<{ degraded: boolean }>(clock(), {
      keep: (answer) => !answer.degraded,
    });
    const loads = controlledLoad<{ degraded: boolean }>();

    const first = cache.read("POL", loads.load);
    (await loads.run(0)).resolve({ degraded: true });
    expect(await first).toEqual({ degraded: true });

    const second = cache.read("POL", loads.load);
    (await loads.run(1)).resolve({ degraded: false });
    expect(await second).toEqual({ degraded: false });

    expect(await cache.read("POL", loads.load)).toEqual({ degraded: false });
    expect(loads.count()).toBe(2);
  });

  test("an expired flight that fails late does not drop the newer answer", async () => {
    const time = clock();
    const cache = cacheOf<string>(time);
    const loads = controlledLoad<string>();

    const stale = cache.read("POL", loads.load);
    const staleRun = await loads.run(0);
    time.advance(60_000);
    const fresh = cache.read("POL", loads.load);
    (await loads.run(1)).resolve("fresh");
    expect(await fresh).toBe("fresh");

    const lateFailure = new TypeError("late failure");
    staleRun.reject(lateFailure);
    expect(await rejectionOf(stale)).toBe(lateFailure);

    expect(await cache.read("POL", loads.load)).toBe("fresh");
    expect(loads.count()).toBe(2);
  });

  test("a load that throws before its first await is dropped like any failure", async () => {
    const cache = cacheOf<string>(clock());
    let calls = 0;
    const failure = new TypeError("thrown at once");
    const failing = async (): Promise<string> => {
      calls += 1;
      throw failure;
    };

    expect(await rejectionOf(cache.read("POL", failing))).toBe(failure);
    expect(await rejectionOf(cache.read("POL", failing))).toBe(failure);
    expect(calls).toBe(2);
  });

  test("holds at most maxEntries keys, evicting the least recently stored", async () => {
    const cache = cacheOf<string>(clock(), { maxEntries: 2 });
    const loaded: string[] = [];
    const load = (key: string) => async () => {
      loaded.push(key);
      return await Promise.resolve(key);
    };

    await cache.read("A", load("A"));
    await cache.read("B", load("B"));
    await cache.read("C", load("C"));
    await cache.read("B", load("B"));
    await cache.read("A", load("A"));

    expect(loaded).toEqual(["A", "B", "C", "A"]);
  });
});
