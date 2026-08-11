type MapWithConcurrencyOptions<Item, Value> = {
  items: readonly Item[];
  limit: number;
  operation: (item: Item, index: number) => Promise<Value>;
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
