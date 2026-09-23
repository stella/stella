/**
 * Explicit pages over a cursor-only search.
 *
 * The corpus answers with a cursor, not an offset: page N is only reachable by
 * walking there, and the cursor of a page nobody has visited does not exist.
 * So the URL carries a page number and the browser keeps the chain of cursors
 * it has walked (the infinite query's own page list). A load that arrives
 * without that chain walks one to the page the URL names, up to the depth
 * limit; only where the results themselves run out first does the page fall
 * back to the deepest one the chain reached.
 *
 * All of that is arithmetic over three numbers, which is why it lives here and
 * not in the route.
 */

import * as v from "valibot";

export const PUBLIC_LAW_PAGE_SIZES = [25, 50, 100] as const;

export type PublicLawPageSize = (typeof PUBLIC_LAW_PAGE_SIZES)[number];

export const DEFAULT_PUBLIC_LAW_PAGE_SIZE = 50 satisfies PublicLawPageSize;

/**
 * How deep a link may reach. Every page beyond the first costs one request the
 * reader has to walk, so a hand-typed or crawled `page=100000` is not a page,
 * it is a request to make a hundred thousand of them.
 */
export const PUBLIC_LAW_MAX_PAGE = 40;

const isPublicLawPageSize = (value: number): value is PublicLawPageSize =>
  PUBLIC_LAW_PAGE_SIZES.some((size) => size === value);

/** The size a URL asks for, or the default when it asks for one we do not offer. */
export const publicLawPageSize = (
  value: number | undefined,
): PublicLawPageSize =>
  value !== undefined && isPublicLawPageSize(value)
    ? value
    : DEFAULT_PUBLIC_LAW_PAGE_SIZE;

/** The page a URL asks for; anything that is not one of ours is the first. */
export const publicLawPageNumber = (value: number | undefined): number =>
  value !== undefined &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= PUBLIC_LAW_MAX_PAGE
    ? value
    : 1;

/** What the URL carries for a page: nothing, when it is the first. */
export const publicLawPageSearchValue = (page: number): number | undefined =>
  page <= 1 ? undefined : page;

/** What the URL carries for a size: nothing, when it is the default. */
export const publicLawPageSizeSearchValue = (
  pageSize: PublicLawPageSize,
): PublicLawPageSize | undefined =>
  pageSize === DEFAULT_PUBLIC_LAW_PAGE_SIZE ? undefined : pageSize;

/**
 * How many pages of the chain the loader asks for.
 *
 * A shared link, a reload, a new tab and a crawler all arrive with no chain at
 * all, so the loader walks one to the page the URL names instead of dropping
 * the reader on the first: the pager's links are real addresses, which is the
 * whole reason they are links. The walk is bounded by the depth limit, which
 * `publicLawPageNumber` has already applied. A browser that walked further on
 * its own keeps what it holds, so a refresh never shortens the chain.
 */
export const publicLawPagesToWalk = (
  page: number,
  walkedPageCount: number,
): number => Math.max(publicLawPageNumber(page), walkedPageCount, 1);

/**
 * The deepest page this browser can show, given the cursors it has walked. A
 * link to a page past the chain resolves to the last one in it rather than to
 * an empty table.
 */
export const reachablePublicLawPage = (
  page: number,
  walkedPageCount: number,
): number => {
  const deepest = Math.max(walkedPageCount, 1);
  return Math.min(publicLawPageNumber(page), deepest);
};

/** Which of the walked pages is on screen. */
export const publicLawPageIndex = (
  page: number,
  walkedPageCount: number,
): number => reachablePublicLawPage(page, walkedPageCount) - 1;

export type PublicLawPagerModel = {
  currentPage: number;
  /** Every page already walked, in order: each one is a direct link. */
  pages: number[];
  previousPage: number | null;
  /** The next page, walked or not; null at the end of the results. */
  nextPage: number | null;
};

type PublicLawPagerInput = {
  page: number;
  walkedPageCount: number;
  /** Whether the last walked page named a cursor after it. */
  hasNextPage: boolean;
};

/**
 * What the pager offers: the pages behind the reader as links, the one after
 * the last walked page as a step forward, and nothing beyond the depth limit.
 */
const nextPublicLawPage = (
  currentPage: number,
  walked: number,
  hasNextPage: boolean,
): number | null => {
  if (currentPage < walked) {
    return currentPage + 1;
  }
  if (hasNextPage && walked < PUBLIC_LAW_MAX_PAGE) {
    return walked + 1;
  }
  return null;
};

export const publicLawPagerModel = ({
  hasNextPage,
  page,
  walkedPageCount,
}: PublicLawPagerInput): PublicLawPagerModel => {
  const walked = Math.max(walkedPageCount, 1);
  const currentPage = reachablePublicLawPage(page, walked);
  return {
    currentPage,
    pages: Array.from({ length: walked }, (_, index) => index + 1),
    previousPage: currentPage > 1 ? currentPage - 1 : null,
    nextPage: nextPublicLawPage(currentPage, walked, hasNextPage),
  };
};

/**
 * Which page of the results, and how large a page is, as a route's search
 * schema reads them. Both are dropped from the URL at their default, and both
 * are read leniently: a public link may be typed or crawled, and a page number
 * nobody can reach is the first page, not an error screen.
 */
export const publicLawPageSearchSchema = v.fallback(
  v.optional(
    v.pipe(
      v.union([v.number(), v.string()]),
      v.transform((value) => publicLawPageNumber(Number(value))),
      v.transform((page) => publicLawPageSearchValue(page)),
    ),
  ),
  undefined,
);

export const publicLawPageSizeSearchSchema = v.fallback(
  v.optional(
    v.pipe(
      v.union([v.number(), v.string()]),
      v.transform((value) => publicLawPageSize(Number(value))),
      v.transform((pageSize) => publicLawPageSizeSearchValue(pageSize)),
    ),
  ),
  undefined,
);
