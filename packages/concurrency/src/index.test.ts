import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestClock, deferred, type TestClock } from "@stll/test-kit";

import { mapWithConcurrency, streamWithConcurrency } from "./index";

const virtualElapsedMs = async (
  clock: TestClock,
  operation: () => Promise<unknown>,
): Promise<number> => {
  const startedAt = clock.monotonic();
  const pending = operation();
  const drainClock = async (): Promise<void> => {
    await Promise.resolve();
    if (await clock.advanceToNext()) {
      await drainClock();
    }
  };
  await Promise.all([pending, drainClock()]);
  return clock.monotonic() - startedAt;
};

/** The shape this helper replaced, kept as the harness's baseline. */
const windowedMap = async <Item, Value>({
  items,
  limit,
  operation,
}: {
  items: readonly Item[];
  limit: number;
  operation: (item: Item) => Promise<Value>;
}): Promise<Value[]> => {
  const values: Value[] = [];
  for (let start = 0; start < items.length; start += limit) {
    const window = await Promise.all(
      items
        .slice(start, start + limit)
        .map(async (item) => await operation(item)),
    );
    values.push(...window);
  }
  return values;
};

const drain = async <Value>(
  stream: AsyncGenerator<Value>,
): Promise<Value[]> => {
  const values: Value[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
};

describe("mapWithConcurrency", () => {
  test("does not execute more than its concurrency limit", async () => {
    let active = 0;
    let peakActive = 0;
    const values = await mapWithConcurrency({
      items: [1, 2, 3, 4, 5],
      limit: 2,
      operation: async (value) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await Promise.resolve();
        active -= 1;
        return value;
      },
    });
    expect(values).toEqual([1, 2, 3, 4, 5]);
    expect(peakActive).toBe(2);
  });
});

describe("streamWithConcurrency", () => {
  test("yields results in input order despite out-of-order completion", async () => {
    const started = [1, 2, 3, 4, 5].map(() => deferred());
    const releases = [1, 2, 3, 4, 5].map(() => deferred());
    const completed = [1, 2, 3, 4, 5].map(() => deferred());
    const completionOrder: number[] = [];
    const draining = drain(
      streamWithConcurrency({
        items: [1, 2, 3, 4, 5],
        limit: 5,
        operation: async (value) => {
          started[value - 1]?.resolve();
          await releases[value - 1]?.promise;
          completionOrder.push(value);
          completed[value - 1]?.resolve();
          return value;
        },
      }),
    );
    await Promise.all(started.map(async ({ promise }) => await promise));
    for (const value of [5, 4, 3, 2, 1]) {
      releases[value - 1]?.resolve();
      await completed[value - 1]?.promise;
    }
    const values = await draining;
    expect(completionOrder).toEqual([5, 4, 3, 2, 1]);
    expect(values).toEqual([1, 2, 3, 4, 5]);
  });

  test("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peakActive = 0;
    const values = await drain(
      streamWithConcurrency({
        items: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        limit: 3,
        operation: async (value) => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          await Promise.resolve();
          active -= 1;
          return value;
        },
      }),
    );
    expect(peakActive).toBe(3);
    expect(values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("handles empty input", async () => {
    expect(
      await drain(
        streamWithConcurrency({
          items: [],
          limit: 3,
          operation: async (value: number) => value,
        }),
      ),
    ).toEqual([]);
  });

  test("treats a limit below 1 as 1", async () => {
    expect(
      await drain(
        streamWithConcurrency({
          items: [1, 2, 3],
          limit: 0,
          operation: async (value) => value,
        }),
      ),
    ).toEqual([1, 2, 3]);
  });

  test("rethrows in input order after the results before it", async () => {
    const failure = new Error("third item");
    const yielded: number[] = [];
    const failed = deferred();
    const releaseOthers = deferred();
    const stream = streamWithConcurrency({
      items: [0, 1, 2, 3, 4],
      limit: 5,
      operation: async (value) => {
        // The failure settles first; the consumer must still see 0 and 1.
        if (value === 2) {
          failed.resolve();
          return await Promise.reject(failure);
        }
        await releaseOthers.promise;
        return value;
      },
    });
    const consuming = (async () => {
      for await (const value of stream) {
        yielded.push(value);
      }
      return null;
    })().then(
      () => null,
      (error: unknown) => error,
    );
    await failed.promise;
    await Promise.resolve();
    releaseOthers.resolve();
    const rejection = await consuming;
    expect(yielded).toEqual([0, 1]);
    expect(rejection).toBe(failure);
  });

  /**
   * The reason this helper exists rather than a windowed `Promise.all`.
   *
   * A window refills only once its slowest member settles, so one slow item
   * per window costs the run one slow item per window, serialized. A pool
   * replaces each operation as it completes, so the slow items overlap each
   * other and everything else.
   */
  test("one slow item per window does not cost a window each", async () => {
    const limit = 8;
    const items = Array.from({ length: 32 }, (_unused, index) => index);
    const makeOperation = (clock: TestClock) => async (index: number) => {
      await clock.sleep(index % limit === 0 ? 120 : 10);
      return index;
    };

    const windowedClock = createTestClock();
    const windowed = await virtualElapsedMs(
      windowedClock,
      async () =>
        await windowedMap({
          items,
          limit,
          operation: makeOperation(windowedClock),
        }),
    );
    const pooledClock = createTestClock();
    const pooled = await virtualElapsedMs(
      pooledClock,
      async () =>
        await drain(
          streamWithConcurrency({
            items,
            limit,
            lookAhead: limit,
            operation: makeOperation(pooledClock),
          }),
        ),
    );

    expect(pooled).toBeLessThan(windowed * 0.7);
  });

  test("a run of N items costs about ceil(N / limit) latencies, not N", async () => {
    const limit = 16;
    const latencyMs = 20;
    const items = Array.from({ length: 64 }, (_unused, index) => index);
    const pooled = Math.ceil(items.length / limit) * latencyMs;
    const serial = items.length * latencyMs;
    const clock = createTestClock();

    const total = await virtualElapsedMs(
      clock,
      async () =>
        await drain(
          streamWithConcurrency({
            items,
            limit,
            lookAhead: limit,
            operation: async (index) => {
              await clock.sleep(latencyMs);
              return index;
            },
          }),
        ),
    );

    expect(total).toBeLessThan(pooled * 3);
    expect(total).toBeLessThan(serial / 4);
  });

  /**
   * What a window cannot do: keep reading while the consumer works. The
   * corpus projection cycle spends that time appending a request, and the
   * next reads have to already be in flight when it returns.
   */
  test("keeps the pool in flight while the consumer is busy", async () => {
    const clock = createTestClock();
    const limit = 4;
    const lookAhead = 4;
    let started = 0;
    let completed = 0;
    const stream = streamWithConcurrency({
      items: Array.from({ length: 12 }, (_unused, index) => index),
      limit,
      lookAhead,
      operation: async (index) => {
        started += 1;
        await clock.sleep(5);
        completed += 1;
        return index;
      },
    });

    const first = stream.next();
    await clock.advance(5);
    expect((await first).value).toBe(0);
    // Long enough for every operation the pool will start to finish.
    await clock.advance(100);

    // A full pool, the look-ahead, and the slot the consumed result freed,
    // and nothing past that: work continues while the consumer is blocked,
    // and residency stays bounded.
    expect(started).toBe(limit + lookAhead + 1);
    expect(completed).toBe(limit + lookAhead + 1);
    await stream.return(undefined);
  });

  test("without look-ahead a settled result holds its slot", async () => {
    const clock = createTestClock();
    const limit = 4;
    let started = 0;
    const stream = streamWithConcurrency({
      items: Array.from({ length: 12 }, (_unused, index) => index),
      limit,
      operation: async (index) => {
        started += 1;
        await clock.sleep(5);
        return index;
      },
    });

    const first = stream.next();
    await clock.advance(5);
    expect((await first).value).toBe(0);
    await clock.advance(100);

    // The consumer has taken one result, so exactly one slot reopened.
    expect(started).toBe(limit + 1);
    await stream.return(undefined);
  });

  /**
   * A consumer abandons the run because its remaining work became invalid, so
   * the pool must not keep paying for it. Each running operation refills on
   * settlement, which without a closed pool would cascade through the whole
   * list behind the consumer's back.
   */
  test("stops refilling once the consumer closes the stream", async () => {
    const clock = createTestClock();
    const items = Array.from({ length: 32 }, (_unused, index) => index);
    let started = 0;
    const stream = streamWithConcurrency({
      items,
      limit: 4,
      lookAhead: 4,
      operation: async (index) => {
        started += 1;
        await clock.sleep(5);
        return index;
      },
    });

    const first = stream.next();
    await clock.advance(5);
    expect((await first).value).toBe(0);
    const closing = stream.return(undefined);
    await clock.advance(5);
    await closing;
    const startedWhenClosed = started;

    // Long enough for every operation still running to settle and refill.
    await clock.advance(100);

    expect(started).toBe(startedWhenClosed);
    expect(started).toBeLessThan(items.length);
  });

  test("a consumer that breaks out closes the pool the same way", async () => {
    const clock = createTestClock();
    const items = Array.from({ length: 32 }, (_unused, index) => index);
    let started = 0;
    const loop = (async () => {
      for await (const value of streamWithConcurrency({
        items,
        limit: 4,
        lookAhead: 4,
        operation: async (index) => {
          started += 1;
          await clock.sleep(5);
          return index;
        },
      })) {
        if (value === 0) {
          break;
        }
      }
    })();
    await clock.advance(10);
    await loop;
    const startedWhenClosed = started;

    await clock.advance(100);

    expect(started).toBe(startedWhenClosed);
    expect(started).toBeLessThan(items.length);
  });

  /**
   * Closing must also wait for what is already running. A caller that stops
   * has decided the rest of its work is invalid, so an operation settling
   * afterwards would be writing into work its owner has finished with.
   */
  test("closing waits for the operations already running", async () => {
    const clock = createTestClock();
    let started = 0;
    let completed = 0;
    const loop = (async () => {
      for await (const value of streamWithConcurrency({
        items: Array.from({ length: 32 }, (_unused, index) => index),
        limit: 4,
        lookAhead: 4,
        operation: async (index) => {
          started += 1;
          await clock.sleep(20);
          completed += 1;
          return index;
        },
      })) {
        if (value === 0) {
          break;
        }
      }
    })();
    await clock.advance(40);
    await loop;

    // No sleep: the loop does not finish until the generator has unwound.
    expect(completed).toBe(started);
  });

  test("a fractional limit cannot admit an extra operation", async () => {
    let active = 0;
    let peakActive = 0;
    const values = await drain(
      streamWithConcurrency({
        items: [1, 2, 3, 4],
        // `inFlight < 1.5` is true at one in flight; flooring is what stops
        // the second from starting.
        limit: 1.5,
        lookAhead: 2,
        operation: async (value) => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          await Promise.resolve();
          active -= 1;
          return value;
        },
      }),
    );
    expect(peakActive).toBe(1);
    expect(values).toEqual([1, 2, 3, 4]);
  });

  test("a non-finite limit is a defect, not a clamp", async () => {
    // NaN would clamp to a pool that starts nothing and returns an empty run.
    expect(
      await rejectionOf(
        drain(
          streamWithConcurrency({
            items: [1, 2, 3],
            limit: Number.NaN,
            operation: async (value) => value,
          }),
        ),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "Concurrency limit must be a finite number",
      ),
    });
  });
});

/**
 * `Item` is unconstrained, so `undefined` is an ordinary element. Reading one
 * as an end-of-list sentinel silently truncated the run in `mapWithConcurrency`
 * and tripped the lost-item panic in `streamWithConcurrency`.
 */
describe("a list containing undefined", () => {
  const items = [1, undefined, 3, undefined, 5];

  test("mapWithConcurrency runs every item", async () => {
    const seen: (number | undefined)[] = [];
    const values = await mapWithConcurrency({
      items,
      limit: 2,
      operation: async (value) => {
        seen.push(value);
        return value;
      },
    });
    expect(values).toEqual(items);
    expect(seen).toHaveLength(items.length);
  });

  test("streamWithConcurrency yields every item", async () => {
    expect(
      await drain(
        streamWithConcurrency({
          items,
          limit: 2,
          lookAhead: 2,
          operation: async (value) => value,
        }),
      ),
    ).toEqual(items);
  });
});
