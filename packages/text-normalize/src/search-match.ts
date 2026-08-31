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

export const foldSearchMatchText = (value: string): string =>
  foldSearchMatchTextBeforeCase(value).toLowerCase();

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
  const contextualLowercase = beforeCase.toLowerCase();
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
    const lowered = unit.text.toLowerCase();
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
    if (firstRange && lastRange) {
      matches.push({ start: firstRange.start, end: lastRange.end });
      if (matches.length >= maxMatches) {
        break;
      }
    }
    searchFrom = foldedEnd;
  }

  return matches;
};
