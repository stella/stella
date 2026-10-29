import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");

// A planning process observes one immutable checkout, so reads and parses of
// the repository are cached for the process. Any other root (a test fixture)
// may change between calls, so it is read fresh.
export const cachedForRepository = <Value>(
  cache: Map<string, Value>,
  { root, key }: { root: string; key: string },
  compute: () => Value,
) => {
  if (root !== repositoryRoot) {
    return compute();
  }
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const value = compute();
  cache.set(key, value);
  return value;
};
