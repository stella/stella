import { panic } from "better-result";

/**
 * Running an async operation over a list with a bounded number in flight.
 *
 * Two shapes, and the difference is latency. {@link mapWithConcurrency}
 * answers "every result", so its caller waits for the slowest item.
 * {@link streamWithConcurrency} answers "each result, in order, as soon as
 * it is ready", so a caller that works per result overlaps that work with
 * the operations still running.
 *
 * Neither is a windowed `Promise.all` over slices. A window refills only
 * once its slowest member settles, so effective concurrency decays to the
 * tail of every slice, and whatever the caller does between slices runs
 * with nothing in flight at all.
 *
 * Both walk `items` with an iterator rather than testing an indexed read for
 * `undefined`: `Item` is unconstrained, so `undefined` is an ordinary element
 * and a sentinel read of one would end the run early on a list that merely
 * contains a hole.
 */

type BoundedConcurrencyOptions<Item, Value> = {
  items: readonly Item[];
  /**
   * Most operations in flight at once.
   *
   * Rounded down and floored at one, so a caller cannot ask for a fraction of
   * an operation and get two: `inFlight < 1.5` admits a second.
   */
  limit: number;
  operation: (item: Item) => Promise<Value>;
};

const poolWidth = (limit: number, itemCount: number): number => {
  if (!Number.isFinite(limit)) {
    // Not a runtime condition: NaN would silently clamp to a pool that starts
    // nothing at all, and no caller can mean "unbounded" from a bounded API.
    return panic(`Concurrency limit must be a finite number, got ${limit}`);
  }
  return Math.min(Math.max(Math.floor(limit), 1), itemCount);
};

/**
 * Every result, in input order, with at most `limit` operations in flight.
 *
 * Rejects as soon as one operation rejects; operations already started run
 * to completion unobserved, so the operation must be safe to abandon.
 */
export const mapWithConcurrency = async <Item, Value>({
  items,
  limit,
  operation,
}: BoundedConcurrencyOptions<Item, Value>): Promise<Value[]> => {
  const values: Value[] = [];
  const iterator = items[Symbol.iterator]();
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    const next = iterator.next();
    if (next.done === true) {
      return;
    }
    const index = nextIndex;
    nextIndex += 1;
    values[index] = await operation(next.value);
    await run();
  };
  await Promise.all(
    Array.from({ length: poolWidth(limit, items.length) }, run),
  );
  return values;
};

type StreamWithConcurrencyOptions<Item, Value> = BoundedConcurrencyOptions<
  Item,
  Value
> & {
  /**
   * How many settled results may wait, unconsumed, ahead of the consumer.
   *
   * This is what decides whether the pool refills on completion or on
   * consumption, and it is a throughput/residency trade rather than a
   * default anyone should inherit blindly.
   *
   * At zero, a settled result holds its slot until the consumer takes it,
   * so an operation that finishes behind a slower one cannot be replaced:
   * the pool slides rather than refills, and at most `limit` results are
   * resident. Above zero, an operation is replaced the moment it settles,
   * so the pool stays full through a slow head and through the consumer's
   * own work, at the cost of up to `limit + lookAhead` resident results.
   *
   * Pick zero when a result is large enough that residency is the binding
   * constraint, `limit` when the results are small and the run's latency is.
   */
  lookAhead?: number;
};

/**
 * One started operation: the promise the consumer awaits, and its settlement.
 *
 * The two are separate because a pool that runs ahead of its consumer has to
 * observe a rejection long before the consumer reaches it. `settled` attaches
 * a handler the moment the operation starts, so a rejection behind a slower
 * item is never reported as unhandled; `value` is left untouched, so awaiting
 * it in input order raises the original rejection to the consumer unchanged.
 */
type PoolSlot<Value> = {
  value: Promise<Value>;
  settled: Promise<void>;
};

/**
 * Each result, in input order, as soon as that result is ready.
 *
 * A rejection reaches the consumer in input order, after the results before
 * it.
 *
 * Nothing outlives the consumer. Stopping early — `break`, `return`, or a
 * rejection — closes the pool: no operation starts after that, and closing
 * waits for the ones already running to settle. A caller that stops has
 * usually decided the rest of its work is invalid, and an operation
 * finishing afterwards would be writing into that abandoned work: a build
 * still adding to a timing total the cycle already returned, a read still
 * opening a transaction past the boundary that owned it.
 *
 * @yields {Value} each operation's result, in the order of `items`.
 */
export const streamWithConcurrency = async function* <Item, Value>({
  items,
  limit,
  lookAhead = 0,
  operation,
}: StreamWithConcurrencyOptions<Item, Value>): AsyncGenerator<Value> {
  const width = poolWidth(limit, items.length);
  const capacity = width + Math.max(lookAhead, 0);
  const iterator = items[Symbol.iterator]();
  const started: PoolSlot<Value>[] = [];
  let inFlight = 0;
  let closed = false;
  // Mutually recursive with `fill`: a settled operation frees its slot and
  // refills the pool, which is what keeps work going while the consumer is
  // busy with an earlier result.
  const startOne = (item: Item): PoolSlot<Value> => {
    const value = (async () => await operation(item))();
    const settled = (async () => {
      await Promise.allSettled([value]);
      inFlight -= 1;
      fill();
    })();
    return { value, settled };
  };
  const fill = (): void => {
    // Checked on entry rather than per iteration: nothing the loop body does
    // can close the pool, and only a settlement or the consumer calls back in.
    if (closed) {
      return;
    }
    while (inFlight < width && started.length < capacity) {
      const next = iterator.next();
      if (next.done === true) {
        return;
      }
      inFlight += 1;
      started.push(startOne(next.value));
    }
  };
  try {
    fill();
    while (started.length > 0) {
      const slot = started.shift() ?? panic("Lost a bounded-pool slot");
      await slot.settled;
      fill();
      yield await slot.value;
    }
  } finally {
    // Reached on every exit, including the consumer's `break` or `return`,
    // which resumes this generator only to unwind it. Closing first means the
    // settlements awaited below cannot start anything more.
    closed = true;
    const settlements: Promise<void>[] = [];
    for (const slot of started) {
      settlements.push(slot.settled);
    }
    await Promise.allSettled(settlements);
  }
};
