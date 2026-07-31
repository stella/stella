import { applyArabicFolds } from "@stll/text-normalize";

const COMBINING_MARKS = /\p{M}+/gu;
const SINGLE_SEARCH_TERM = /^[\p{L}\p{N}]$/u;

export type SearchTextMatch = {
  start: number;
  end: number;
};

export type SearchTextQuery =
  | string
  | { type: "separate-terms"; terms: readonly string[] };

type FindNormalizedSearchTextMatchesOptions = {
  maxMatches?: number;
};

type NormalizedSearchTextWithOffsets = {
  originalRanges: SearchTextMatch[];
  text: string;
};

const normalizeSearchTextBeforeCase = (value: string): string =>
  applyArabicFolds(value.normalize("NFKD").replace(COMBINING_MARKS, ""));

export const normalizeSearchText = (value: string): string =>
  normalizeSearchTextBeforeCase(value).toLowerCase();

const normalizeSearchTextWithOffsets = (
  content: string,
): NormalizedSearchTextWithOffsets => {
  const units: { range: SearchTextMatch; text: string }[] = [];
  let originalOffset = 0;

  for (const character of content) {
    const start = originalOffset;
    originalOffset += character.length;
    units.push({
      range: { start, end: originalOffset },
      text: normalizeSearchTextBeforeCase(character),
    });
  }

  const beforeCase = units.map(({ text }) => text).join("");
  const contextualLowercase = beforeCase.toLowerCase();
  if (contextualLowercase.length === beforeCase.length) {
    const originalRanges: SearchTextMatch[] = [];
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

  const loweredParts: string[] = [];
  const originalRanges: SearchTextMatch[] = [];
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

export const searchTextQueryKey = (query: SearchTextQuery): string =>
  typeof query === "string"
    ? `query:${JSON.stringify(query)}`
    : `separate-terms:${JSON.stringify(query.terms)}`;

export const getSearchTextCandidates = (
  searchText: SearchTextQuery,
): string[] => {
  if (typeof searchText !== "string") {
    return searchText.terms
      .map((term) => term.trim())
      .filter(
        (term, index, terms) =>
          (term.length > 1 || SINGLE_SEARCH_TERM.test(term)) &&
          terms.indexOf(term) === index,
      );
  }

  const normalizedSearchText = searchText.trim();
  if (normalizedSearchText.length === 0) {
    return [];
  }

  const matchedTerms = normalizedSearchText.match(/[\p{L}\p{N}]+/gu);
  const terms: string[] = [];
  if (matchedTerms) {
    terms.push(...matchedTerms);
  }
  return [normalizedSearchText, ...terms].filter(
    (candidate, index, candidates) =>
      (candidate.length > 1 || SINGLE_SEARCH_TERM.test(candidate)) &&
      candidates.indexOf(candidate) === index,
  );
};

export const findNormalizedSearchTextMatches = (
  content: string,
  searchText: string,
  options: FindNormalizedSearchTextMatchesOptions = {},
): SearchTextMatch[] => {
  const maxMatches = Math.max(
    0,
    Math.floor(options.maxMatches ?? Number.MAX_SAFE_INTEGER),
  );
  if (maxMatches === 0) {
    return [];
  }

  const normalizedContent = normalizeSearchTextWithOffsets(content);
  const normalizedQuery = normalizeSearchText(searchText.trim());
  if (normalizedQuery.length === 0) {
    return [];
  }

  const matches: SearchTextMatch[] = [];
  let searchFrom = 0;
  while (searchFrom <= normalizedContent.text.length - normalizedQuery.length) {
    const normalizedStart = normalizedContent.text.indexOf(
      normalizedQuery,
      searchFrom,
    );
    if (normalizedStart === -1) {
      break;
    }
    const normalizedEnd = normalizedStart + normalizedQuery.length;
    const firstRange = normalizedContent.originalRanges.at(normalizedStart);
    const lastRange = normalizedContent.originalRanges.at(normalizedEnd - 1);
    if (firstRange && lastRange) {
      matches.push({ start: firstRange.start, end: lastRange.end });
      if (matches.length >= maxMatches) {
        break;
      }
    }
    searchFrom = normalizedEnd;
  }

  return matches;
};
