const collators = new Map<string, Intl.Collator>();

/**
 * `Intl.Collator` for `locale`, cached per locale.
 *
 * Mirrors `apps/web/src/lib/collation.ts` for the handful of server-side
 * sorts over human-readable text (as opposed to sorting by an opaque id,
 * which should stay locale-independent). See that file for the full
 * rationale on caching and the default ("variant") sensitivity.
 */
export const getCollator = (locale: string): Intl.Collator => {
  const cached = collators.get(locale);
  if (cached) {
    return cached;
  }
  const collator = new Intl.Collator(locale);
  collators.set(locale, collator);
  return collator;
};

/**
 * Comparator factory for `.sort()` / `.toSorted()` on plain strings, backed
 * by the cached collator for `locale`.
 */
export const compareByLocale = (
  locale: string,
): ((a: string, b: string) => number) => {
  const collator = getCollator(locale);
  return (a, b) => collator.compare(a, b);
};
