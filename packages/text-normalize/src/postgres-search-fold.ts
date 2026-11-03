/**
 * The client half of PostgreSQL's `search_fold(text)`: `lower(unaccent(...))`
 * with the extension's default dictionary, reproduced code point for code
 * point so a highlighter marks exactly what a server-side fold matched.
 *
 * Deliberately narrower than `foldSearchMatchText`, which also decomposes,
 * strips every combining mark and folds Arabic and final sigma: marking a run
 * the server did not match would claim a match that never happened. Here a
 * character the extension has no rule for keeps its marks, `ς` stays `ς`, and
 * precomposed and decomposed spellings agree only because the extension maps
 * the precomposed letter and deletes the combining mark.
 *
 * Both halves are per code point: `unaccent` replaces single code points (its
 * rules have no multi-character sources), and `lower()` under a libc or
 * builtin collation maps each code point on its own. The parity test in
 * `apps/api/src/lib/search/postgres-search-fold-parity.db.test.ts` holds this
 * against a live database for every assigned code point.
 */

import { findFoldedRanges } from "./search-match.js";
import type { FoldedSearchText, SearchMatchRange } from "./search-match.js";
import { POSTGRES_UNACCENT_RULES } from "./unaccent-rules.js";

/**
 * `toLowerCase` applies Unicode's full mapping, while `lower()` maps one code
 * point to one (the simple mapping). The two differ only where the full
 * mapping expands, and the one unconditional expansion (U+0130 to `i` plus
 * U+0307) keeps the simple mapping as its first code point. Lowering one code
 * point at a time also keeps JavaScript's contextual final sigma out, which
 * `lower()` never applies.
 */
const lowerCodePoint = (character: string): string => {
  // Destructuring a string iterates code points, so this is the first one.
  const [simple = character] = character.toLowerCase();
  return simple;
};

/**
 * One code point's fold. Lone surrogates cannot reach the database (a UTF-8
 * database refuses them), so they fold as the replacement character the way
 * `toWellFormed` spells them.
 */
const foldCodePoint = (character: string): string => {
  const wellFormed = character.toWellFormed();
  const unaccented = POSTGRES_UNACCENT_RULES[wellFormed] ?? wellFormed;
  let lowered = "";
  for (const codePoint of unaccented) {
    lowered += lowerCodePoint(codePoint);
  }
  return lowered;
};

/** `search_fold(value)` as PostgreSQL computes it. */
export const foldLikePostgresSearch = (value: string): string => {
  let folded = "";
  for (const character of value) {
    folded += foldCodePoint(character);
  }
  return folded;
};

/**
 * `foldLikePostgresSearch` with each folded UTF-16 unit mapped back to the
 * code point it came from. A code point the fold deletes (a combining mark)
 * joins the range of the one before it, so a match that ends on `e` in
 * `é` covers the accent the reader sees on it.
 */
export const foldLikePostgresSearchWithOffsets = (
  content: string,
): FoldedSearchText => {
  const parts: string[] = [];
  const originalRanges: SearchMatchRange[] = [];
  let previous: SearchMatchRange | undefined;
  let offset = 0;
  for (const character of content) {
    const range = { start: offset, end: offset + character.length };
    offset = range.end;
    const folded = foldCodePoint(character);
    if (folded === "") {
      if (previous !== undefined) {
        previous.end = range.end;
      }
      continue;
    }
    parts.push(folded);
    // One entry per UTF-16 unit, not per code point: matches index units.
    let unit = 0;
    while (unit < folded.length) {
      originalRanges.push(range);
      unit += 1;
    }
    previous = range;
  }
  return { originalRanges, text: parts.join("") };
};

/**
 * Non-overlapping occurrences of `term` in `content` under the PostgreSQL
 * search fold, as ranges into the original `content`. The term is folded as
 * given, not trimmed.
 */
export const findPostgresSearchFoldRanges = (
  content: string,
  term: string,
): SearchMatchRange[] =>
  findFoldedRanges({
    content: foldLikePostgresSearchWithOffsets(content),
    maxMatches: Number.MAX_SAFE_INTEGER,
    query: foldLikePostgresSearch(term),
  });
