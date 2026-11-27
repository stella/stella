import { panic } from "better-result";

type KeyedStreamOptions<Item, Value> = {
  items: readonly Item[];
  /** Most operations in flight at once; floored at one. */
  limit: number;
  /**
   * Keys of an item: an item never starts while an earlier item sharing one
   * of them is still running.
   */
  keysOf: (item: Item, index: number) => readonly string[];
  /**
   * Asked before every start, and again whenever a started operation settles
   * or the consumer takes a result. While it answers false nothing starts;
   * once nothing is left running or untaken, the stream ends.
   */
  admits: () => boolean;
  operation: (item: Item, index: number) => Promise<Value>;
};

type Slot<Value> = {
  index: number;
  value: Promise<Value>;
  settled: Promise<void>;
};

/**
 * Each result, in input order, as soon as that result is ready, with at most
 * `limit` operations in flight and none overlapping an earlier one that
 * shares a key.
 *
 * Items start in input order: an item held by a running key holds the items
 * after it as well, so whatever started is always a prefix of `items`, and a
 * consumer that stops early leaves an unstarted suffix and nothing else.
 *
 * Nothing outlives the consumer. Stopping early (`break`, `return`, a
 * rejection) closes the stream: nothing starts after that, and closing waits
 * for the operations already running to settle.
 *
 * @yields {{ index: number; value: Value }} each started item's result, in
 *   input order.
 */
export const streamKeyedInOrder = async function* <Item, Value>({
  items,
  limit,
  keysOf,
  admits,
  operation,
}: KeyedStreamOptions<Item, Value>): AsyncGenerator<{
  index: number;
  value: Value;
}> {
  if (!Number.isFinite(limit)) {
    panic(`Concurrency limit must be a finite number, got ${limit}`);
  }
  const width = Math.max(Math.floor(limit), 1);
  const entries = items.map((item, index) => ({ item, index }));
  const running = new Map<string, number>();
  const started: Slot<Value>[] = [];
  let next = 0;
  let inFlight = 0;
  let closed = false;
  const hold = (keys: readonly string[], delta: 1 | -1): void => {
    for (const key of keys) {
      const count = (running.get(key) ?? 0) + delta;
      if (count === 0) {
        running.delete(key);
      } else {
        running.set(key, count);
      }
    }
  };
  // Mutually recursive with `fill`: a settled operation frees its keys and
  // its slot, which may let the held item start.
  const start = (item: Item, index: number, keys: readonly string[]) => {
    hold(keys, 1);
    inFlight += 1;
    const value = (async () => await operation(item, index))();
    const settled = (async () => {
      const [outcome] = await Promise.allSettled([value]);
      hold(keys, -1);
      inFlight -= 1;
      if (outcome.status === "rejected") {
        // The consumer receives this rejection at its index; nothing starts
        // in the meantime, so the slot it frees stays empty.
        closed = true;
      }
      fill();
    })();
    started.push({ index, value, settled });
  };
  let heldKeys: { index: number; keys: readonly string[] } | null = null;
  // Starts the next item if it may start, then asks again: at most `width`
  // deep, since every start takes a slot.
  const fill = (): void => {
    const entry = entries[next];
    if (closed || inFlight >= width || entry === undefined || !admits()) {
      return;
    }
    const { item, index } = entry;
    const keys =
      heldKeys?.index === index ? heldKeys.keys : keysOf(item, index);
    if (keys.some((key) => running.has(key))) {
      heldKeys = { index, keys };
      return;
    }
    heldKeys = null;
    next += 1;
    start(item, index, keys);
    fill();
  };
  try {
    fill();
    while (started.length > 0) {
      const slot = started.shift() ?? panic("Lost a keyed stream slot");
      await slot.settled;
      yield { index: slot.index, value: await slot.value };
      fill();
    }
  } finally {
    closed = true;
    await Promise.allSettled(
      started.map(async ({ settled }) => {
        await settled;
      }),
    );
  }
};
