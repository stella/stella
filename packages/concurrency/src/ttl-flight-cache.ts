/**
 * A process-local cache of whole answers, one shared flight per key.
 *
 * For a read whose answer is the same for every caller for a while: a miss
 * starts one load, every caller that asks for the same key while it runs
 * waits on that load instead of starting its own, and the settled answer is
 * served until it expires. The expiry counts from when the load started, so
 * an answer is never older than the window however long the load took.
 *
 * A load that fails is answered to the callers waiting on it and then
 * dropped, never served again; so is an answer `keep` refuses, such as a
 * degraded one, so the next caller asks again instead of being handed the
 * degradation for a whole window.
 *
 * Nothing here is required for correctness: a cold process, an eviction or a
 * dropped answer only means the load runs again.
 */

type TtlFlightCacheOptions<Value> = {
  ttlMs: number;
  /** Most keys held; the least recently stored is evicted first. */
  maxEntries: number;
  /** Epoch milliseconds; injected so expiry is testable without waiting. */
  now: () => number;
  /** Whether a settled answer may be served to later callers. */
  keep?: (value: Value) => boolean;
};

type Entry<Value> = {
  expiresAt: number;
  /** Which read started the load, so a late settlement drops only its own. */
  flight: symbol;
  value: Promise<Value>;
};

export type TtlFlightCache<Value> = {
  read: (key: string, load: () => Promise<Value>) => Promise<Value>;
};

export const createTtlFlightCache = <Value>({
  ttlMs,
  maxEntries,
  now,
  keep = () => true,
}: TtlFlightCacheOptions<Value>): TtlFlightCache<Value> => {
  // Map order is insertion order: a store re-inserts, eviction takes the first.
  const entries = new Map<string, Entry<Value>>();

  const read = async (
    key: string,
    load: () => Promise<Value>,
  ): Promise<Value> => {
    const startedAt = now();
    const cached = entries.get(key);
    if (cached !== undefined && cached.expiresAt > startedAt) {
      return await cached.value;
    }
    const flight = Symbol(key);
    // Only this flight's own entry is dropped: a newer flight stored under the
    // same key after this one expired is not this flight's to remove.
    const drop = () => {
      if (entries.get(key)?.flight === flight) {
        entries.delete(key);
      }
    };
    const settle = async (): Promise<Value> => {
      let kept = false;
      try {
        // Started a microtask later, once the entry below is stored, so a
        // load that fails at once is dropped like any other failure.
        const answer = await Promise.resolve().then(load);
        kept = keep(answer);
        return answer;
      } finally {
        // Before any waiting caller resumes: a caller that follows a failure
        // or a refused answer finds no entry and loads again.
        if (!kept) {
          drop();
        }
      }
    };
    const value = settle();
    entries.delete(key);
    entries.set(key, { expiresAt: startedAt + ttlMs, flight, value });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) {
        break;
      }
      entries.delete(oldest.value);
    }
    return await value;
  };

  return { read };
};
