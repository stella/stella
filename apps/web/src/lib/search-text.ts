import type { SearchMatchRange as FoldedMatchRange } from "@stll/text-normalize";

// The folding core with original-index mapping lives in @stll/text-normalize
// (search-match.ts) so the desktop clipboard search shares one behavior with
// the web previews; the legacy names below cover this module's consumers.
export {
  findSearchMatchRanges as findNormalizedSearchTextMatches,
  foldSearchMatchText as normalizeSearchText,
} from "@stll/text-normalize";

const SINGLE_SEARCH_TERM = /^[\p{L}\p{N}]$/u;

export type SearchTextMatch = FoldedMatchRange;

type SearchMatchRange = SearchTextMatch & { group: number };

type SelectNonOverlappingSearchMatchesOptions<T> = {
  getRange: (match: T) => SearchMatchRange;
  matches: Iterable<T>;
  maxMatches: number;
};

export const selectNonOverlappingSearchMatches = <T>({
  getRange,
  matches,
  maxMatches,
}: SelectNonOverlappingSearchMatchesOptions<T>): T[] => {
  if (maxMatches <= 0) {
    return [];
  }
  const selected: T[] = [];
  let previousEnd = -1;
  let previousGroup = -1;
  const ordered = [...matches]
    .map((match) => ({ match, range: getRange(match) }))
    .toSorted(
      (first, second) =>
        first.range.group - second.range.group ||
        first.range.start - second.range.start ||
        second.range.end - first.range.end,
    );
  for (const { match, range } of ordered) {
    if (range.group !== previousGroup) {
      previousGroup = range.group;
      previousEnd = -1;
    }
    if (range.start < previousEnd) {
      continue;
    }
    selected.push(match);
    previousEnd = range.end;
    if (selected.length >= maxMatches) {
      break;
    }
  }
  return selected;
};

export type SearchTextQuery =
  | string
  | { type: "separate-terms"; terms: readonly string[] };

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
