// parser-output-unchanged: `findSearchMatchRanges` hands its scan to `findFoldedRanges` with the same folded content, query and budget; the ranges it returns are unchanged.
// parser-output-unchanged: match-case, match-diacritics and whole-word options are opt-in; without them every fold and range is unchanged.

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
 *
 * `SearchMatchOptions` narrow the match for a find field's toggles: keep
 * letter case, keep accents (characters match as written, apart from case),
 * or accept only matches that start and end on word boundaries.
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

export type SearchFoldOptions = {
  /** Letters keep their case: `Čez` no longer matches `čez`. */
  matchCase?: boolean;
  /**
   * Characters match as written apart from case: no accent, stroke (`ł`) or
   * Arabic orthographic fold, so `cez` no longer matches `čez`. Both sides
   * are still NFKD-decomposed, so composed and decomposed accents agree.
   */
  matchDiacritics?: boolean;
};

export type SearchMatchOptions = SearchFoldOptions & {
  /**
   * A match may not continue a word: a query edge that is a letter, digit or
   * mark needs a non-word neighbour (or the text edge) on that side.
   */
  wholeWords?: boolean;
};

const foldSearchMatchTextBeforeCase = (
  value: string,
  { matchDiacritics = false }: SearchFoldOptions,
): string =>
  matchDiacritics
    ? value.normalize("NFKD")
    : applyArabicFolds(
        applyAsciiFolds(value.normalize("NFKD")).replace(COMBINING_MARKS, ""),
      );

const caseFold = (
  value: string,
  { matchCase = false }: SearchFoldOptions,
): string =>
  matchCase ? value : value.toLowerCase().replace(FINAL_SIGMA, "σ");

export const foldSearchMatchText = (
  value: string,
  options: SearchFoldOptions = {},
): string => caseFold(foldSearchMatchTextBeforeCase(value, options), options);

export const foldSearchMatchTextWithOffsets = (
  content: string,
  options: SearchFoldOptions = {},
): FoldedSearchText => {
  const units: { range: SearchMatchRange; text: string }[] = [];
  let originalOffset = 0;

  for (const character of content) {
    const start = originalOffset;
    originalOffset += character.length;
    units.push({
      range: { start, end: originalOffset },
      text: foldSearchMatchTextBeforeCase(character, options),
    });
  }

  const beforeCase = units.map(({ text }) => text).join("");
  const contextualLowercase = caseFold(beforeCase, options);
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
    const lowered = caseFold(unit.text, options);
    loweredParts.push(lowered);
    let codeUnit = 0;
    while (codeUnit < lowered.length) {
      originalRanges.push(unit.range);
      codeUnit += 1;
    }
  }
  return { text: loweredParts.join(""), originalRanges };
};

const WORD_CHARACTER = /^[\p{L}\p{N}\p{M}]$/u;
const MARK_CHARACTER = /^\p{M}$/u;

const codePointAt = (text: string, index: number) => {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
};

const codePointBefore = (text: string, index: number) => {
  if (index <= 0) {
    return "";
  }
  // Read at a pair's second half, `codePointAt` returns the lone low
  // surrogate; the pair then starts one unit earlier.
  const previous = text.codePointAt(index - 1) ?? 0;
  const pairStart =
    previous >= 0xdc_00 && previous <= 0xdf_ff && index >= 2
      ? index - 2
      : index - 1;
  return codePointAt(text, pairStart);
};

/**
 * Whether a folded occurrence of the folded query at `start` satisfies the
 * options. Folded text keeps marks only when diacritics must match; a match
 * that stops in front of one would then claim `c` inside `č` (`c` + caron).
 */
const acceptsFoldedMatch = (
  text: string,
  query: string,
  start: number,
  { matchDiacritics = false, wholeWords = false }: SearchMatchOptions,
) => {
  const end = start + query.length;
  const next = codePointAt(text, end);
  if (matchDiacritics && MARK_CHARACTER.test(next)) {
    return false;
  }
  if (!wholeWords) {
    return true;
  }
  if (
    WORD_CHARACTER.test(codePointAt(query, 0)) &&
    WORD_CHARACTER.test(codePointBefore(text, start))
  ) {
    return false;
  }
  return !(
    WORD_CHARACTER.test(codePointBefore(query, query.length)) &&
    WORD_CHARACTER.test(next)
  );
};

/**
 * Whether the folded query occurs in folded text under the options. For
 * callers that cache a folded string without offsets and only filter.
 */
export const hasFoldedSearchMatch = (
  text: string,
  query: string,
  options: SearchMatchOptions = {},
): boolean => {
  if (query.length === 0) {
    return false;
  }
  let from = text.indexOf(query);
  while (from !== -1) {
    if (acceptsFoldedMatch(text, query, from, options)) {
      return true;
    }
    from = text.indexOf(query, from + 1);
  }
  return false;
};

type FindFoldedRangesOptions = {
  content: FoldedSearchText;
  maxMatches: number;
  /** Already folded by the same fold as `content`. */
  query: string;
  match?: SearchMatchOptions;
};

/**
 * Non-overlapping occurrences of a folded query in folded content, as ranges
 * into the original string. Shared by every fold that carries
 * `originalRanges`, so they agree on what "non-overlapping" means.
 */
export const findFoldedRanges = ({
  content,
  maxMatches,
  query,
  match,
}: FindFoldedRangesOptions): SearchMatchRange[] => {
  if (maxMatches <= 0 || query.length === 0) {
    return [];
  }

  const matches: SearchMatchRange[] = [];
  let searchFrom = 0;
  while (searchFrom <= content.text.length - query.length) {
    const foldedStart = content.text.indexOf(query, searchFrom);
    if (foldedStart === -1) {
      break;
    }
    if (
      match !== undefined &&
      !acceptsFoldedMatch(content.text, query, foldedStart, match)
    ) {
      searchFrom = foldedStart + 1;
      continue;
    }
    const foldedEnd = foldedStart + query.length;
    const firstRange = content.originalRanges.at(foldedStart);
    const lastRange = content.originalRanges.at(foldedEnd - 1);
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
      (content.originalRanges.at(searchFrom)?.start ?? Infinity) < lastRange.end
    ) {
      searchFrom += 1;
    }
  }

  return matches;
};

type FindSearchMatchRangesOptions = SearchMatchOptions & {
  maxMatches?: number;
};

/**
 * Non-overlapping occurrences of the folded query in the content, as ranges
 * into the original string. Accepts pre-folded content so callers matching
 * many queries against the same text fold it once; pre-folded content must
 * come from the same fold options.
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

  const match = {
    matchCase: options.matchCase ?? false,
    matchDiacritics: options.matchDiacritics ?? false,
    wholeWords: options.wholeWords ?? false,
  } satisfies SearchMatchOptions;
  return findFoldedRanges({
    content:
      typeof content === "string"
        ? foldSearchMatchTextWithOffsets(content, match)
        : content,
    maxMatches,
    query: foldSearchMatchText(query.trim(), match),
    match,
  });
};
