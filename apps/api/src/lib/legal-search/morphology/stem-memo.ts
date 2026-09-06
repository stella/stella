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

/**
 * @param maxEntries Entries the young generation holds before it rotates.
 * Live entries are bounded by twice this, since the previous generation is
 * retained until the next rotation.
 */
export const createBoundedMemo = (maxEntries: number): BoundedMemo => {
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
