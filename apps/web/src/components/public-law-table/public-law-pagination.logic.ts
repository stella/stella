/**
 * Explicit pages over the public-law result lists, in two shapes.
 *
 * A list answered by cursor only (statutes) is walked: page N is reachable
 * only by walking there, and the cursor of a page nobody has visited does not
 * exist. So the URL carries a page number and the browser keeps the chain of
 * cursors it has walked (the infinite query's own page list). A load that
 * arrives without that chain walks one to the page the URL names, up to the
 * depth limit; only where the results themselves run out first does the page
 * fall back to the deepest one the chain reached.
 *
 * A list addressed by offset (case law) reaches any page up to its deepest in
 * one request, so its pager numbers the pages from the total instead
 * (`publicLawNumberedPagerModel`).
 *
 * All of that is arithmetic over a few numbers, which is why it lives here and
 * not in the routes.
 */

import { panic } from "better-result";
import * as v from "valibot";

import { SEARCH_TOTAL_TYPE, type SearchTotal } from "@stll/api-contract/search";

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

/**
 * The page a URL asks for; anything that is not one of ours is the first. A
 * list addressed by offset passes its own deepest page; the walked lists keep
 * the walk's depth limit.
 */
export const publicLawPageNumber = (
  value: number | undefined,
  deepestPage = PUBLIC_LAW_MAX_PAGE,
): number =>
  value !== undefined &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= deepestPage
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

/** One slot of a numbered pager: a page, or the run of pages it leaves out. */
export type PublicLawPageItem =
  | { type: "page"; page: number }
  /** Pages between `after` and the next page item, not drawn one by one. */
  | { type: "gap"; after: number };

/** Pages drawn on either side of the current one. */
const PAGE_WINDOW_RADIUS = 2;

type PublicLawPageWindowInput = {
  currentPage: number;
  /** The last page a button may lead to: the results' end or the depth bound. */
  lastPage: number;
};

/**
 * The page buttons around the reader: the first and the last page, and the
 * pages near the current one, `1 … 4 5 [6] 7 8 … 20`. A gap stands for two
 * pages or more: one left-out page is drawn instead, since an ellipsis is no
 * narrower than the number it would hide.
 */
export const publicLawPageWindow = ({
  currentPage,
  lastPage,
}: PublicLawPageWindowInput): PublicLawPageItem[] => {
  const last = Math.max(1, lastPage);
  const current = Math.min(Math.max(1, currentPage), last);
  const shown = new Set([1, last]);
  for (
    let page = current - PAGE_WINDOW_RADIUS;
    page <= current + PAGE_WINDOW_RADIUS;
    page += 1
  ) {
    if (page >= 1 && page <= last) {
      shown.add(page);
    }
  }

  const items: PublicLawPageItem[] = [];
  let previous: number | null = null;
  for (const page of [...shown].toSorted((left, right) => left - right)) {
    if (previous !== null && page - previous === 2) {
      items.push({ type: "page", page: previous + 1 });
    } else if (previous !== null && page - previous > 2) {
      items.push({ type: "gap", after: previous });
    }
    items.push({ type: "page", page });
    previous = page;
  }
  return items;
};

/** How many pages the results fill, as far as the search counted them. */
export type PublicLawPageCount =
  | {
      type: "counted";
      /** An estimate is drawn with `~` and read out as approximate. */
      precision:
        | typeof SEARCH_TOTAL_TYPE.EXACT
        | typeof SEARCH_TOTAL_TYPE.ESTIMATE;
      pages: number;
    }
  | { type: "not_counted" };

export type PublicLawNumberedPagerModel = {
  currentPage: number;
  /** The numbered buttons; none when the results were not counted. */
  items: PublicLawPageItem[];
  previousPage: number | null;
  nextPage: number | null;
  pageCount: PublicLawPageCount;
  /**
   * The results run on past the deepest page a request may reach. No button
   * leads there; the pager asks the reader to narrow the search instead.
   */
  beyondReach: boolean;
};

type PublicLawNumberedPagerInput = {
  page: number;
  pageSize: number;
  /** The deepest page a request may address at this page size. */
  deepestPage: number;
  total: SearchTotal;
  /** Whether the search reported results after the page on screen. */
  hasMore: boolean;
};

/**
 * What a pager over a list addressed by offset offers. Every page up to the
 * deepest reachable one is one request away, so the pager numbers them from
 * the total; a total that was not counted leaves it the step either way.
 */
export const publicLawNumberedPagerModel = ({
  deepestPage,
  hasMore,
  page,
  pageSize,
  total,
}: PublicLawNumberedPagerInput): PublicLawNumberedPagerModel => {
  const currentPage = Math.min(Math.max(1, page), Math.max(1, deepestPage));
  const previousPage = currentPage > 1 ? currentPage - 1 : null;

  switch (total.type) {
    case SEARCH_TOTAL_TYPE.EXACT:
    case SEARCH_TOTAL_TYPE.ESTIMATE: {
      // An estimate can fall short of where the results really end, so the
      // page on screen saying another follows outweighs the arithmetic.
      const pages = Math.max(
        Math.ceil(total.count / pageSize),
        hasMore ? currentPage + 1 : currentPage,
      );
      const lastPage = Math.min(pages, deepestPage);
      return {
        currentPage,
        items: publicLawPageWindow({ currentPage, lastPage }),
        previousPage,
        nextPage: currentPage < lastPage ? currentPage + 1 : null,
        pageCount: {
          type: "counted",
          precision: total.type,
          pages,
        },
        beyondReach: pages > deepestPage,
      };
    }
    case SEARCH_TOTAL_TYPE.NOT_COUNTED:
      return {
        currentPage,
        items: [],
        previousPage,
        nextPage: hasMore && currentPage < deepestPage ? currentPage + 1 : null,
        pageCount: { type: "not_counted" },
        beyondReach: hasMore && currentPage >= deepestPage,
      };
    default:
      total satisfies never;
      return panic("Unhandled search total");
  }
};

/**
 * Which page of the results, and how large a page is, as a route's search
 * schema reads them. Both are dropped from the URL at their default, and both
 * are read leniently: a public link may be typed or crawled, and a page number
 * nobody can reach is the first page, not an error screen.
 */
export const publicLawPageSearchSchemaUpTo = (deepestPage: number) =>
  v.fallback(
    v.optional(
      v.pipe(
        v.union([v.number(), v.string()]),
        v.transform((value) => publicLawPageNumber(Number(value), deepestPage)),
        v.transform((page) => publicLawPageSearchValue(page)),
      ),
    ),
    undefined,
  );

/** The page of a list walked by cursor, up to the walk's depth limit. */
export const publicLawPageSearchSchema =
  publicLawPageSearchSchemaUpTo(PUBLIC_LAW_MAX_PAGE);

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
