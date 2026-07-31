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

export const normalizeSearchText = (value: string): string =>
  value.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();

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

  const normalizedContentParts: string[] = [];
  const originalRanges: SearchTextMatch[] = [];
  let originalOffset = 0;

  for (const character of content) {
    const start = originalOffset;
    originalOffset += character.length;
    const normalizedCharacter = normalizeSearchText(character);
    normalizedContentParts.push(normalizedCharacter);
    for (const _codeUnit of normalizedCharacter.split("")) {
      originalRanges.push({ start, end: originalOffset });
    }
  }

  const normalizedContent = normalizedContentParts.join("");
  const normalizedQuery = normalizeSearchText(searchText.trim());
  if (normalizedQuery.length === 0) {
    return [];
  }

  const matches: SearchTextMatch[] = [];
  let searchFrom = 0;
  while (searchFrom <= normalizedContent.length - normalizedQuery.length) {
    const normalizedStart = normalizedContent.indexOf(
      normalizedQuery,
      searchFrom,
    );
    if (normalizedStart === -1) {
      break;
    }
    const normalizedEnd = normalizedStart + normalizedQuery.length;
    const firstRange = originalRanges.at(normalizedStart);
    const lastRange = originalRanges.at(normalizedEnd - 1);
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
