export const MAX_SEARCH_PREVIEW_MATCHES = 200;

export type SearchMatchSummary = {
  count: number;
  truncated: boolean;
};

type SearchMatchResult = {
  matches: readonly unknown[];
  truncated: boolean;
};

type GetSettledSearchMatchSummaryOptions = {
  isSettled: boolean;
  result: SearchMatchResult | null | undefined;
};

export const getSettledSearchMatchSummary = ({
  isSettled,
  result,
}: GetSettledSearchMatchSummaryOptions): SearchMatchSummary | null => {
  if (!isSettled) {
    return null;
  }

  return {
    count: result?.matches.length ?? 0,
    truncated: result?.truncated ?? false,
  };
};

type GetAdjacentSearchMatchIndexOptions = {
  activeIndex: number;
  direction: "next" | "previous";
  matchCount: number;
};

export const getAdjacentSearchMatchIndex = ({
  activeIndex,
  direction,
  matchCount,
}: GetAdjacentSearchMatchIndexOptions): number => {
  if (matchCount <= 0) {
    return 0;
  }

  const delta = direction === "next" ? 1 : -1;
  return (activeIndex + delta + matchCount) % matchCount;
};

type GetCenteredSearchMatchScrollTopOptions = {
  containerHeight: number;
  containerTop: number;
  currentScrollTop: number;
  matchHeight: number;
  matchTop: number;
};

export const getCenteredSearchMatchScrollTop = ({
  containerHeight,
  containerTop,
  currentScrollTop,
  matchHeight,
  matchTop,
}: GetCenteredSearchMatchScrollTopOptions): number =>
  Math.max(
    0,
    currentScrollTop +
      matchTop -
      containerTop -
      (containerHeight - matchHeight) / 2,
  );
