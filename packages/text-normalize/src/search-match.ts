/**
 * Diacritic-insensitive substring matching with original-index mapping.
 *
 * `foldSearchMatchText` builds the client-side match key: NFKD
 * decomposition, the `unaccent()`-parity ASCII folds (letters with no
 * decomposition: `ł`, `ø`, `đ`, `ß`), combining-mark strip, Arabic
 * orthographic folds, then lowercase — so a `capek` query matches `Čapek`
 * and `wroclaw` matches `Wrocław`, both ways. It is deliberately distinct
 * from `arabicNormalize` (normalize.ts), which is pinned to the SQL
 * `arabic_normalize()` contract and must not strip Latin diacritics.
 *
 * `findSearchMatchRanges` locates a folded query inside folded content and
 * reports matches as ranges into the ORIGINAL string, so highlights wrap the
 * text the user actually sees. Folding changes string length (per-character
 * decomposition, mark removal, contextual lowercasing), so the folded form
 * carries a per-code-unit map back to the originating character's range.
 */

import { applyArabicFolds } from "./arabic.js";
import { applyAsciiFolds } from "./ascii-fold.js";

const COMBINING_MARKS = /\p{M}+/gu;
// `toLowerCase` keeps the positional final sigma that Unicode case folding
// maps to σ; a lone `σ` query would otherwise miss the end of `ΟΣ`. Same
// length, so offsets are unaffected; a full `toUpperCase().toLowerCase()`
// fold is not used because it changes lengths (ß → SS) and the ASCII table
// already covers those letters.
const FINAL_SIGMA = /ς/gu;

export type SearchMatchRange = {
  end: number;
  start: number;
};

export type FoldedSearchText = {
  /** Original-string character range for each folded UTF-16 code unit. */
  originalRanges: SearchMatchRange[];
  text: string;
};

const foldSearchMatchTextBeforeCase = (value: string): string =>
  applyArabicFolds(
    applyAsciiFolds(value.normalize("NFKD")).replace(COMBINING_MARKS, ""),
  );

const caseFold = (value: string): string =>
  value.toLowerCase().replace(FINAL_SIGMA, "σ");

export const foldSearchMatchText = (value: string): string =>
  caseFold(foldSearchMatchTextBeforeCase(value));

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

export const foldSearchMatchTextWithOffsets = (
  content: string,
): FoldedSearchText => {
  const units: { range: SearchMatchRange; text: string }[] = [];
  let originalOffset = 0;

  for (const character of content) {
    const start = originalOffset;
    originalOffset += character.length;
    units.push({
      range: { start, end: originalOffset },
      text: foldSearchMatchTextBeforeCase(character),
    });
  }

  const beforeCase = units.map(({ text }) => text).join("");
  const contextualLowercase = caseFold(beforeCase);
  if (contextualLowercase.length === beforeCase.length) {
    const originalRanges: SearchMatchRange[] = [];
    for (const unit of units) {
      let codeUnit = 0;
      while (codeUnit < unit.text.length) {
        originalRanges.push(unit.range);
        codeUnit += 1;
      }
    }
    return {
      text: contextualLowercase,
      originalRanges,
    };
  }

  // Lowercasing changed the length (e.g. İ gains a combining dot), so the
  // whole-string result cannot be aligned with the per-character units;
  // lowercase each unit separately instead.
  const loweredParts: string[] = [];
  const originalRanges: SearchMatchRange[] = [];
  for (const unit of units) {
    const lowered = caseFold(unit.text);
    loweredParts.push(lowered);
    let codeUnit = 0;
    while (codeUnit < lowered.length) {
      originalRanges.push(unit.range);
      codeUnit += 1;
    }
  }
  return { text: loweredParts.join(""), originalRanges };
};

type FindSearchMatchRangesOptions = {
  maxMatches?: number;
};

/**
 * Non-overlapping occurrences of the folded query in the content, as ranges
 * into the original string. Accepts pre-folded content so callers matching
 * many queries against the same text fold it once.
 */
export const findSearchMatchRanges = (
  content: string | FoldedSearchText,
  query: string,
  options: FindSearchMatchRangesOptions = {},
): SearchMatchRange[] => {
  const maxMatches = Math.max(
    0,
    Math.floor(options.maxMatches ?? Number.MAX_SAFE_INTEGER),
  );
  if (maxMatches === 0) {
    return [];
  }

  const foldedContent =
    typeof content === "string"
      ? foldSearchMatchTextWithOffsets(content)
      : content;
  const foldedQuery = foldSearchMatchText(query.trim());
  if (foldedQuery.length === 0) {
    return [];
  }

  const matches: SearchMatchRange[] = [];
  let searchFrom = 0;
  while (searchFrom <= foldedContent.text.length - foldedQuery.length) {
    const foldedStart = foldedContent.text.indexOf(foldedQuery, searchFrom);
    if (foldedStart === -1) {
      break;
    }
    const foldedEnd = foldedStart + foldedQuery.length;
    const firstRange = foldedContent.originalRanges.at(foldedStart);
    const lastRange = foldedContent.originalRanges.at(foldedEnd - 1);
    if (!firstRange || !lastRange) {
      break;
    }
    matches.push({ start: firstRange.start, end: lastRange.end });
    if (matches.length >= maxMatches) {
      break;
    }
    // An expanding fold (ß → ss) maps several folded units to one original
    // character; resume after the last unit inside the matched characters so
    // that character is reported once and the budget reaches later hits.
    searchFrom = foldedEnd;
    while (
      (foldedContent.originalRanges.at(searchFrom)?.start ?? Infinity) <
      lastRange.end
    ) {
      searchFrom += 1;
    }
  }

  return matches;
};
