type MapWithConcurrencyOptions<Item, Value> = {
  items: readonly Item[];
  limit: number;
  operation: (item: Item, index: number) => Promise<Value>;
};

export type ConcurrencyLimiter = <Value>(
  operation: () => Promise<Value>,
) => Promise<Value>;

/** Share a FIFO concurrency budget across independently scheduled work. */
export const createConcurrencyLimiter = (limit: number): ConcurrencyLimiter => {
  const maximumActive = Math.max(limit, 1);
  const waiting: (() => void)[] = [];
  let active = 0;

  const acquire = async (): Promise<void> => {
    if (active < maximumActive) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  };

  return async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    await acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  };
};

/** Map in input order while never running more than `limit` operations. */
export const mapWithConcurrency = async <Item, Value>({
  items,
  limit,
  operation,
}: MapWithConcurrencyOptions<Item, Value>): Promise<Value[]> => {
  const values: Value[] = [];
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    const item = items.at(index);
    if (item === undefined) {
      return;
    }
    values[index] = await operation(item, index);
    await run();
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, run),
  );
  return values;
};
