type MapConcurrentOptions<T, TResult> = {
  concurrency: number;
  items: readonly T[];
  map: (item: T, index: number) => Promise<TResult>;
};

/** Map in input order while keeping the number of active promises bounded. */
export const mapConcurrent = async <T, TResult>({
  concurrency,
  items,
  map,
}: MapConcurrentOptions<T, TResult>): Promise<TResult[]> => {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive safe integer");
  }

  const results: TResult[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items.at(index);
      if (item === undefined) {
        throw new RangeError("Concurrent map index escaped the input bounds");
      }
      // oxlint-disable-next-line no-await-in-loop -- each fixed worker owns one bounded concurrency slot
      results[index] = await map(item, index);
    }
  });
  await Promise.all(workers);
  return results;
};
