class BoundedLruCache<TKey, TValue> {
  readonly #entries = new Map<TKey, TValue>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get(key: TKey): TValue | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: TKey, value: TValue): void {
    this.#entries.set(key, value);
    if (this.#entries.size <= this.#limit) {
      return;
    }
    const oldestKey = this.#entries.keys().next();
    if (!oldestKey.done) {
      this.#entries.delete(oldestKey.value);
    }
  }
}

const COLLATOR_CACHE_LIMIT = 16;

const collatorCache = new BoundedLruCache<string, Intl.Collator>(
  COLLATOR_CACHE_LIMIT,
);

/**
 * `Intl.Collator` for `locale`, cached per locale.
 *
 * Building a collator loads ICU tailoring data for the locale; doing that
 * once per `.sort()` call (rather than once per pairwise comparison) turns
 * an O(n log n) sort with hidden per-comparison setup cost into a single
 * lookup plus cheap `.compare()` calls.
 *
 * Sensitivity is left at the ICU default ("variant": base letter, then
 * accent, then case is only a tiebreak) — the same tiering
 * `String.prototype.localeCompare` uses without an options argument. That
 * keeps every migrated call site's ordering identical to before; the only
 * behavior change is the locale itself becoming explicit and consistent
 * across environments, instead of falling back to the runtime default (which
 * mis-collates e.g. Czech/Slovak "ch" as a distinct letter sorted after "h"
 * when the runtime doesn't already default to "cs"/"sk").
 */
export const getCollator = (locale: string): Intl.Collator => {
  const cached = collatorCache.get(locale);
  if (cached) {
    return cached;
  }
  // eslint-disable-next-line react-doctor/js-hoist-intl -- per-locale cache getter; the constructor necessarily runs below top level
  const collator = new Intl.Collator(locale);
  collatorCache.set(locale, collator);
  return collator;
};

/**
 * Comparator factory for `.sort()` / `.toSorted()` on plain strings, backed
 * by the cached collator for `locale`:
 *
 *   items.toSorted(compareByLocale(locale))
 *
 * For object arrays, apply the field first:
 *
 *   const compare = compareByLocale(locale);
 *   items.toSorted((a, b) => compare(a.name, b.name));
 */
export const compareByLocale = (
  locale: string,
): ((a: string, b: string) => number) => {
  const collator = getCollator(locale);
  return (a, b) => collator.compare(a, b);
};
