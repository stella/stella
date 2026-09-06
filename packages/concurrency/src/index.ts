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
 */

type BoundedConcurrencyOptions<Item, Value> = {
  items: readonly Item[];
  /** Most operations in flight at once; a value below 1 reads as 1. */
  limit: number;
  operation: (item: Item) => Promise<Value>;
};

const poolWidth = (limit: number, itemCount: number): number =>
  Math.min(Math.max(limit, 1), itemCount);

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
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    const item = items.at(index);
    if (item === undefined) {
      return;
    }
    values[index] = await operation(item);
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
 * it, and abandons the operations still in flight: they must be safe to
 * abandon.
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
  const started: PoolSlot<Value>[] = [];
  let inFlight = 0;
  let nextIndex = 0;
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
    while (
      nextIndex < items.length &&
      inFlight < width &&
      started.length < capacity
    ) {
      const item = items.at(nextIndex) ?? panic("Lost a bounded-pool item");
      nextIndex += 1;
      inFlight += 1;
      started.push(startOne(item));
    }
  };
  fill();
  while (started.length > 0) {
    const slot = started.shift() ?? panic("Lost a bounded-pool slot");
    await slot.settled;
    fill();
    yield await slot.value;
  }
};
