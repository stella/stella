/** Bounded LRU values for authorized, versioned window reads. Callers must
 * resolve live access and source/policy identity before looking up a value. */
export const createWindowReadCache = <TValue>({
  maxBytes,
  sizeOf,
}: {
  maxBytes: number;
  sizeOf: (value: TValue) => number;
}) => {
  const entries = new Map<string, { value: TValue; bytes: number }>();
  let heldBytes = 0;
  return {
    get: (key: string): TValue | undefined => {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set: (key: string, value: TValue): void => {
      const prior = entries.get(key);
      if (prior !== undefined) {
        entries.delete(key);
        heldBytes -= prior.bytes;
      }
      // Include keys and a fixed entry overhead, so small values cannot grow
      // an unbounded map alongside the document byte budget.
      const bytes = sizeOf(value) + key.length * 2 + 128;
      if (bytes > maxBytes) {
        return;
      }
      entries.set(key, { value, bytes });
      heldBytes += bytes;
      for (const [oldestKey, entry] of entries) {
        if (heldBytes <= maxBytes) {
          break;
        }
        entries.delete(oldestKey);
        heldBytes -= entry.bytes;
      }
    },
    clear: (): void => {
      entries.clear();
      heldBytes = 0;
    },
    heldBytes: () => heldBytes,
  };
};
