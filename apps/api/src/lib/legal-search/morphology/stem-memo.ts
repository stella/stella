/**
 * A bounded memo for a pure key → value function.
 *
 * Stemming is a pure function of the term and the language, and a corpus
 * repeats its terms heavily: inside one document, and far more across the
 * documents of one indexing batch. Answering a repeat from the previous
 * answer is therefore identical to re-running the algorithm, which is what
 * lets the projection keep byte-identical output while paying the stemmer
 * once per distinct term.
 *
 * Two generations rather than a linked-list LRU: a hit is one `Map` lookup,
 * an insertion is one `Map` set, and eviction is dropping a whole generation,
 * so nothing per entry has to be tracked to keep the ceiling. A key still in
 * use when the young generation fills is promoted out of the old one instead
 * of being lost at the rotation boundary, so a working set that fits the
 * ceiling survives rotations.
 *
 * The ceiling is on entries *and* on key length. Counting entries alone
 * bounds memory only if entries are of bounded size, which is not something a
 * memo can assume of its caller's keys: one pathological key would otherwise
 * stay resident until tens of thousands of ordinary ones displaced it.
 */

export type BoundedMemo = {
  /**
   * The remembered value for `key`, or what `compute` returns, remembered.
   * The caller supplies `compute` per call so the memo never has to decode a
   * key back into the arguments that produced it.
   */
  get: (key: string, compute: () => string) => string;
  /** Live entries across both generations. Exposed for the bound's tests. */
  size: () => number;
};

type BoundedMemoOptions = {
  /**
   * Entries the young generation holds before it rotates. Live entries are
   * bounded by twice this, since the previous generation is retained until
   * the next rotation.
   */
  maxEntries: number;
  /**
   * Longest key the memo will retain. A key past it is computed and returned
   * but never stored, so the resident bytes are bounded by the entry ceiling
   * times this rather than by the entry ceiling alone.
   *
   * The two ceilings are not interchangeable, and only together do they bound
   * memory: a caller whose keys have no natural length limit can otherwise
   * pin arbitrarily many bytes in a structure that counts only entries.
   */
  maxKeyLength: number;
};

export const createBoundedMemo = ({
  maxEntries,
  maxKeyLength,
}: BoundedMemoOptions): BoundedMemo => {
  let young = new Map<string, string>();
  let old = new Map<string, string>();
  const remember = (key: string, value: string): string => {
    if (young.size >= maxEntries) {
      old = young;
      young = new Map<string, string>();
    }
    young.set(key, value);
    return value;
  };
  return {
    get: (key, compute) => {
      if (key.length > maxKeyLength) {
        return compute();
      }
      const fresh = young.get(key);
      if (fresh !== undefined) {
        return fresh;
      }
      const aged = old.get(key);
      // Promoted rather than read in place: the old generation is dropped at
      // the next rotation, so a key still in use has to move forward to
      // survive it.
      return remember(key, aged ?? compute());
    },
    size: () => {
      let live = young.size;
      for (const key of old.keys()) {
        if (!young.has(key)) {
          live += 1;
        }
      }
      return live;
    },
  };
};
