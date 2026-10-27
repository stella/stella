/**
 * The client-side match for user-typed queries, kept out of the package root
 * so the corpus parsers that read the root do not depend on it.
 */

import { foldSearchMatchText } from "./search-match.js";

// A list filter folds the same names on every keystroke. Remembering their
// keys turns a keystroke over 2,000 three-field rows from about 3 ms into
// about 0.2 ms, level with a bare `toLowerCase().includes()`. The fold is
// pure, so the cache is unobservable; clearing it whole when full bounds its
// memory without an eviction policy.
const CANDIDATE_KEY_CACHE_LIMIT = 10_000;
const candidateKeys = new Map<string, string>();

const candidateKey = (candidate: string): string => {
  const cached = candidateKeys.get(candidate);
  if (cached !== undefined) {
    return cached;
  }
  if (candidateKeys.size >= CANDIDATE_KEY_CACHE_LIMIT) {
    candidateKeys.clear();
  }
  const key = foldSearchMatchText(candidate.toWellFormed());
  candidateKeys.set(candidate, key);
  return key;
};

/** Whether one candidate text contains the query a matcher was built for. */
export type SearchQueryMatcher = (
  candidate: string | null | undefined,
) => boolean;

/**
 * The client-side answer to "does this text match what the user typed".
 *
 * Both sides go through `foldSearchMatchText`, so case, accents, letters
 * without a decomposition (`ł`, `ø`, `ß` → `ss`), compatibility ligatures and
 * Arabic orthographic variants are ignored identically in every UI locale,
 * and a filtered list agrees with the highlights `findSearchMatchRanges`
 * draws in it. The query is trimmed and folded once and candidate keys are
 * cached; a blank query matches every candidate, and a missing candidate
 * matches none. Lone surrogates become U+FFFD on both sides, so a query can
 * never match half of an astral character.
 *
 * Preferred over an `Intl.Collator` with `sensitivity: "base"`: a collator
 * compares equal-length windows, so `strasse` never finds `Straße`; its
 * verdict depends on the runtime locale (Turkish `ISTANBUL` misses
 * `istanbul`, German `Müller` misses `muller`); it keeps Arabic tashkeel
 * significant; and it compares every window of every item per keystroke,
 * where a fold key is computed once per text.
 */
export const createSearchQueryMatcher = (query: string): SearchQueryMatcher => {
  const foldedQuery = foldSearchMatchText(query.trim().toWellFormed());
  if (foldedQuery === "") {
    return () => true;
  }
  return (candidate) =>
    candidate !== null &&
    candidate !== undefined &&
    candidateKey(candidate).includes(foldedQuery);
};

type FilterBySearchQueryOptions<T> = {
  /** The texts an item is found by; it matches when any of them does. */
  fields: (item: T) => readonly (string | null | undefined)[];
  items: readonly T[];
  query: string;
};

/**
 * The items any of whose fields matches the query, in their given order,
 * through `createSearchQueryMatcher`. A blank query keeps every item.
 */
export const filterBySearchQuery = <T>({
  fields,
  items,
  query,
}: FilterBySearchQueryOptions<T>): T[] => {
  const matches = createSearchQueryMatcher(query);
  return items.filter((item) => fields(item).some(matches));
};
