import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createPublicSearchCoalescer } from "@/api/lib/legal-search/public-search-coalescer";

type Answer = { value: number; complete: boolean };

const createCoalescer = (
  overrides: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
) =>
  createPublicSearchCoalescer<Answer>({
    limits: {
      maxEntries: overrides.maxEntries ?? 16,
      maxBytes: 1024 * 1024,
      ttlMs: overrides.ttlMs ?? 1000,
    },
    now: overrides.now ?? (() => 0),
  });

const cacheable = (answer: Answer) => answer.complete;

const deferred = <T>() => Promise.withResolvers<T>();

describe("public search coalescer", () => {
  test("N identical concurrent searches run once and all get the answer", async () => {
    const coalescer = createCoalescer();
    const gate = deferred<Answer>();
    let runs = 0;
    const searches = Array.from({ length: 20 }, async () =>
      coalescer.search({
        key: "same",
        cacheable,
        run: async () => {
          runs += 1;
          return await gate.promise;
        },
      }),
    );
    gate.resolve({ value: 7, complete: true });
    const answers = await Promise.all(searches);
    expect(runs).toBe(1);
    expect(answers.map(({ value }) => value)).toEqual(
      Array.from({ length: 20 }, () => 7),
    );
  });

  test("distinct keys each run their own read", async () => {
    const coalescer = createCoalescer();
    let runs = 0;
    await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        coalescer.search({
          key: String(index),
          cacheable,
          run: async () => {
            runs += 1;
            return { value: index, complete: true };
          },
        }),
      ),
    );
    expect(runs).toBe(5);
  });

  test("a complete answer is served within the TTL and refetched after it", async () => {
    let clock = 0;
    const coalescer = createCoalescer({ now: () => clock, ttlMs: 100 });
    let runs = 0;
    const search = async () =>
      await coalescer.search({
        key: "k",
        cacheable,
        run: async () => {
          runs += 1;
          return { value: runs, complete: true };
        },
      });
    expect((await search()).value).toBe(1);
    clock = 50;
    expect((await search()).value).toBe(1);
    expect(runs).toBe(1);
    clock = 101;
    expect((await search()).value).toBe(2);
  });

  test("an incomplete answer is shared with waiters but never kept", async () => {
    const coalescer = createCoalescer();
    const gate = deferred<Answer>();
    let runs = 0;
    const run = async () => {
      runs += 1;
      return await gate.promise;
    };
    const first = coalescer.search({ key: "k", cacheable, run });
    const second = coalescer.search({ key: "k", cacheable, run });
    gate.resolve({ value: 1, complete: false });
    await Promise.all([first, second]);
    expect(runs).toBe(1);
    await coalescer.search({
      key: "k",
      cacheable,
      run: async () => {
        runs += 1;
        return { value: 2, complete: false };
      },
    });
    expect(runs).toBe(2);
  });

  test("a kept answer is private: mutating one caller's copy changes nothing", async () => {
    const coalescer = createCoalescer();
    const run = async () => ({ value: 1, complete: true });
    const first = await coalescer.search({ key: "k", cacheable, run });
    first.value = 99;
    const second = await coalescer.search({ key: "k", cacheable, run });
    expect(second.value).toBe(1);
  });

  test("a failed read rejects every waiter and is not kept", async () => {
    const coalescer = createCoalescer();
    const gate = deferred<Answer>();
    const run = async () => await gate.promise;
    const first = coalescer.search({ key: "k", cacheable, run });
    const second = coalescer.search({ key: "k", cacheable, run });
    gate.reject(new Error("engine down"));
    expect(await rejectionOf(first)).toMatchObject({ message: "engine down" });
    expect(await rejectionOf(second)).toMatchObject({ message: "engine down" });
    const retried = await coalescer.search({
      key: "k",
      cacheable,
      run: async () => ({ value: 3, complete: true }),
    });
    expect(retried.value).toBe(3);
  });

  test("one caller leaving does not cancel the read for the others", async () => {
    const coalescer = createCoalescer();
    const gate = deferred<Answer>();
    let readAborted = false;
    const left = new AbortController();
    const run = async (signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        readAborted = true;
      });
      return await gate.promise;
    };
    const leaving = coalescer.search({
      key: "k",
      signal: left.signal,
      cacheable,
      run,
    });
    const staying = coalescer.search({ key: "k", cacheable, run });
    left.abort(new Error("caller left"));
    expect(await rejectionOf(leaving)).toMatchObject({
      message: "caller left",
    });
    expect(readAborted).toBe(false);
    gate.resolve({ value: 5, complete: true });
    expect((await staying).value).toBe(5);
  });

  test("the read is cancelled once every caller has left", async () => {
    const coalescer = createCoalescer();
    const gate = deferred<Answer>();
    let abortReason: unknown;
    const first = new AbortController();
    const second = new AbortController();
    const run = async (signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        abortReason = signal.reason;
        gate.reject(signal.reason);
      });
      return await gate.promise;
    };
    const one = coalescer.search({
      key: "k",
      signal: first.signal,
      cacheable,
      run,
    });
    const two = coalescer.search({
      key: "k",
      signal: second.signal,
      cacheable,
      run,
    });
    first.abort(new Error("first left"));
    expect(await rejectionOf(one)).toMatchObject({ message: "first left" });
    expect(abortReason).toBeUndefined();
    second.abort(new Error("second left"));
    expect(await rejectionOf(two)).toMatchObject({ message: "second left" });
    expect(abortReason).toBeDefined();
  });

  test("a caller already cancelled joins nothing", async () => {
    const coalescer = createCoalescer();
    const left = new AbortController();
    left.abort(new Error("gone"));
    let runs = 0;
    expect(
      await rejectionOf(
        coalescer.search({
          key: "k",
          signal: left.signal,
          cacheable,
          run: async () => {
            runs += 1;
            return { value: 1, complete: true };
          },
        }),
      ),
    ).toMatchObject({ message: "gone" });
    expect(runs).toBe(0);
  });

  test("the entry bound evicts the least recently used answer", async () => {
    const coalescer = createCoalescer({ maxEntries: 2 });
    let runs = 0;
    const search = async (key: string) =>
      await coalescer.search({
        key,
        cacheable,
        run: async () => {
          runs += 1;
          return { value: runs, complete: true };
        },
      });
    await search("a");
    await search("b");
    await search("a");
    await search("c");
    expect(runs).toBe(3);
    // "a" was refreshed before "c" arrived, so "b" is the one evicted.
    await search("a");
    expect(runs).toBe(3);
    await search("b");
    expect(runs).toBe(4);
  });
});
