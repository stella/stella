import { describe, expect, test } from "bun:test";

import { mapWithConcurrency, streamWithConcurrency } from "./index";

const elapsedMs = async (
  operation: () => Promise<unknown>,
): Promise<number> => {
  const startedAt = Bun.nanoseconds();
  await operation();
  return (Bun.nanoseconds() - startedAt) / 1e6;
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
    // Later items resolve sooner, so completion order is reversed.
    const values = await drain(
      streamWithConcurrency({
        items: [1, 2, 3, 4, 5],
        limit: 5,
        operation: async (value) => {
          await Bun.sleep((8 - value) * 5);
          return value;
        },
      }),
    );
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
          await Bun.sleep(5);
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
    const stream = streamWithConcurrency({
      items: [0, 1, 2, 3, 4],
      limit: 5,
      operation: async (value) => {
        // The failure settles first; the consumer must still see 0 and 1.
        await Bun.sleep(value === 2 ? 0 : 20);
        return value === 2 ? await Promise.reject(failure) : value;
      },
    });
    const rejection = await (async () => {
      for await (const value of stream) {
        yielded.push(value);
      }
      return null;
    })().then(
      () => null,
      (error: unknown) => error,
    );
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
    const operation = async (index: number) => {
      await Bun.sleep(index % limit === 0 ? 120 : 10);
      return index;
    };

    // Measured back to back, so the comparison survives a slow machine.
    const windowed = await elapsedMs(
      async () => await windowedMap({ items, limit, operation }),
    );
    const pooled = await elapsedMs(
      async () =>
        await drain(
          streamWithConcurrency({ items, limit, lookAhead: limit, operation }),
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

    const total = await elapsedMs(
      async () =>
        await drain(
          streamWithConcurrency({
            items,
            limit,
            lookAhead: limit,
            operation: async (index) => {
              await Bun.sleep(latencyMs);
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
        await Bun.sleep(5);
        completed += 1;
        return index;
      },
    });

    expect((await stream.next()).value).toBe(0);
    // Long enough for every operation the pool will start to finish.
    await Bun.sleep(100);

    // A full pool, the look-ahead, and the slot the consumed result freed,
    // and nothing past that: work continues while the consumer is blocked,
    // and residency stays bounded.
    expect(started).toBe(limit + lookAhead + 1);
    expect(completed).toBe(limit + lookAhead + 1);
    await stream.return(undefined);
  });

  test("without look-ahead a settled result holds its slot", async () => {
    const limit = 4;
    let started = 0;
    const stream = streamWithConcurrency({
      items: Array.from({ length: 12 }, (_unused, index) => index),
      limit,
      operation: async (index) => {
        started += 1;
        await Bun.sleep(5);
        return index;
      },
    });

    expect((await stream.next()).value).toBe(0);
    await Bun.sleep(100);

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
    const items = Array.from({ length: 32 }, (_unused, index) => index);
    let started = 0;
    const stream = streamWithConcurrency({
      items,
      limit: 4,
      lookAhead: 4,
      operation: async (index) => {
        started += 1;
        await Bun.sleep(5);
        return index;
      },
    });

    expect((await stream.next()).value).toBe(0);
    await stream.return(undefined);
    const startedWhenClosed = started;

    // Long enough for every operation still running to settle and refill.
    await Bun.sleep(100);

    expect(started).toBe(startedWhenClosed);
    expect(started).toBeLessThan(items.length);
  });

  test("a consumer that breaks out closes the pool the same way", async () => {
    const items = Array.from({ length: 32 }, (_unused, index) => index);
    let started = 0;
    for await (const value of streamWithConcurrency({
      items,
      limit: 4,
      lookAhead: 4,
      operation: async (index) => {
        started += 1;
        await Bun.sleep(5);
        return index;
      },
    })) {
      if (value === 0) {
        break;
      }
    }
    const startedWhenClosed = started;

    await Bun.sleep(100);

    expect(started).toBe(startedWhenClosed);
    expect(started).toBeLessThan(items.length);
  });

  /**
   * Closing must also wait for what is already running. A caller that stops
   * has decided the rest of its work is invalid, so an operation settling
   * afterwards would be writing into work its owner has finished with.
   */
  test("closing waits for the operations already running", async () => {
    let started = 0;
    let completed = 0;
    for await (const value of streamWithConcurrency({
      items: Array.from({ length: 32 }, (_unused, index) => index),
      limit: 4,
      lookAhead: 4,
      operation: async (index) => {
        started += 1;
        await Bun.sleep(20);
        completed += 1;
        return index;
      },
    })) {
      if (value === 0) {
        break;
      }
    }

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
          await Bun.sleep(5);
          active -= 1;
          return value;
        },
      }),
    );
    expect(peakActive).toBe(1);
    expect(values).toEqual([1, 2, 3, 4]);
  });

  test("a non-finite limit is a defect, not a clamp", () => {
    // NaN would clamp to a pool that starts nothing and returns an empty run.
    expect(
      async () =>
        await drain(
          streamWithConcurrency({
            items: [1, 2, 3],
            limit: Number.NaN,
            operation: async (value) => value,
          }),
        ),
    ).toThrow("Concurrency limit must be a finite number");
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
