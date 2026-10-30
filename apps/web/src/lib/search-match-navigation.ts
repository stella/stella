import { parseDecimalToken } from "@stll/agent-input/numeric-token";

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
  /**
   * Height covered at the container's bottom edge (a floating composer), read
   * with `readScrollPaddingBlockEnd`. Required so no caller can centre a match
   * under an overlay by forgetting it.
   */
  obscuredBlockEnd: number;
};

/** Centres the match in the part of the container that is not covered. */
export const getCenteredSearchMatchScrollTop = ({
  containerHeight,
  containerTop,
  currentScrollTop,
  matchHeight,
  matchTop,
  obscuredBlockEnd,
}: GetCenteredSearchMatchScrollTopOptions): number =>
  Math.max(
    0,
    currentScrollTop +
      matchTop -
      containerTop -
      (Math.max(containerHeight - obscuredBlockEnd, matchHeight) -
        matchHeight) /
        2,
  );

/**
 * The scroll container's `scroll-padding-block-end` in pixels: the safe inset a
 * floating overlay reserves at its bottom edge. The computed value is `auto` or
 * a pixel length; `auto` reads as 0.
 */
export const readScrollPaddingBlockEnd = (scrollContainer: Element): number => {
  const inset = getComputedStyle(scrollContainer).scrollPaddingBlockEnd;
  return inset.endsWith("px")
    ? parseDecimalToken(inset.slice(0, -"px".length), {
        sign: "unsigned",
      }).unwrapOr(0)
    : 0;
};
