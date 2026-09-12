/**
 * Explicit pages over a cursor-only search.
 *
 * The corpus answers with a cursor, not an offset: page N is only reachable by
 * walking there, and the cursor of a page nobody has visited does not exist.
 * So the URL carries a page number, the browser keeps the chain of cursors it
 * has walked (the infinite query's own page list), and a page beyond that
 * chain is not a page this browser can show — it falls back to the deepest one
 * it can.
 *
 * All of that is arithmetic over three numbers, which is why it lives here and
 * not in the route.
 */

export const DECISION_PAGE_SIZES = [25, 50, 100] as const;

export type DecisionPageSize = (typeof DECISION_PAGE_SIZES)[number];

export const DEFAULT_DECISION_PAGE_SIZE = 50 satisfies DecisionPageSize;

/**
 * How deep a link may reach. Every page beyond the first costs one request the
 * reader has to walk, so a hand-typed or crawled `page=100000` is not a page,
 * it is a request to make a hundred thousand of them.
 */
export const DECISION_MAX_PAGE = 40;

const isDecisionPageSize = (value: number): value is DecisionPageSize =>
  DECISION_PAGE_SIZES.some((size) => size === value);

/** The size a URL asks for, or the default when it asks for one we do not offer. */
export const decisionPageSize = (
  value: number | undefined,
): DecisionPageSize =>
  value !== undefined && isDecisionPageSize(value)
    ? value
    : DEFAULT_DECISION_PAGE_SIZE;

/** The page a URL asks for; anything that is not one of ours is the first. */
export const decisionPageNumber = (value: number | undefined): number =>
  value !== undefined &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= DECISION_MAX_PAGE
    ? value
    : 1;

/** What the URL carries for a page: nothing, when it is the first. */
export const decisionPageSearchValue = (page: number): number | undefined =>
  page <= 1 ? undefined : page;

/** What the URL carries for a size: nothing, when it is the default. */
export const decisionPageSizeSearchValue = (
  pageSize: DecisionPageSize,
): DecisionPageSize | undefined =>
  pageSize === DEFAULT_DECISION_PAGE_SIZE ? undefined : pageSize;

/**
 * The deepest page this browser can show, given the cursors it has walked. A
 * link to a page past the chain resolves to the last one in it rather than to
 * an empty table.
 */
export const reachableDecisionPage = (
  page: number,
  walkedPageCount: number,
): number => {
  const deepest = Math.max(walkedPageCount, 1);
  return Math.min(decisionPageNumber(page), deepest);
};

/** Which of the walked pages is on screen. */
export const decisionPageIndex = (
  page: number,
  walkedPageCount: number,
): number => reachableDecisionPage(page, walkedPageCount) - 1;

export type DecisionPagerModel = {
  currentPage: number;
  /** Every page already walked, in order: each one is a direct link. */
  pages: number[];
  previousPage: number | null;
  /** The next page, walked or not; null at the end of the results. */
  nextPage: number | null;
};

type DecisionPagerInput = {
  page: number;
  walkedPageCount: number;
  /** Whether the last walked page named a cursor after it. */
  hasNextPage: boolean;
};

/**
 * What the pager offers: the pages behind the reader as links, the one after
 * the last walked page as a step forward, and nothing beyond the depth limit.
 */
const nextDecisionPage = (
  currentPage: number,
  walked: number,
  hasNextPage: boolean,
): number | null => {
  if (currentPage < walked) {
    return currentPage + 1;
  }
  if (hasNextPage && walked < DECISION_MAX_PAGE) {
    return walked + 1;
  }
  return null;
};

export const decisionPagerModel = ({
  hasNextPage,
  page,
  walkedPageCount,
}: DecisionPagerInput): DecisionPagerModel => {
  const walked = Math.max(walkedPageCount, 1);
  const currentPage = reachableDecisionPage(page, walked);
  return {
    currentPage,
    pages: Array.from({ length: walked }, (_, index) => index + 1),
    previousPage: currentPage > 1 ? currentPage - 1 : null,
    nextPage: nextDecisionPage(currentPage, walked, hasNextPage),
  };
};
