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
  // eslint-disable-next-line react-doctor/js-hoist-intl -- per-locale cache getter; the constructor necessarily runs below top level
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

/**
 * Plain codepoint comparator for `.sort()` / `.toSorted()` on strings that
 * are ids, paths, or other technical keys rather than user-facing text (lock
 * ordering, archive entry order, search tiebreaks, ...). Unlike
 * `.localeCompare()`, this is bit-identical across environments regardless
 * of runtime/ICU locale.
 */
export const compareCodepoint = (a: string, b: string): number =>
  a < b ? -1 : Number(a > b);
