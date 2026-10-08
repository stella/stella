/**
 * Which pages of a case-law result list exist. Both result endpoints take an
 * offset, bounded by the depth the API serves (`CASE_LAW_RESULT_DEPTH_MAX`,
 * shared with the API rather than copied), so the deepest page depends only
 * on the page size.
 */

import { CASE_LAW_RESULT_DEPTH_MAX } from "@stll/api-contract/limits";
import { SEARCH_TOTAL_TYPE, type SearchTotal } from "@stll/api-contract/search";

import {
  PUBLIC_LAW_PAGE_REST,
  PUBLIC_LAW_PAGE_SIZES,
  publicLawPageNumber,
  type PublicLawPageRest,
  type PublicLawPageSize,
} from "@/components/public-law-table/public-law-pagination.logic";
import type { PublicLawRowsPhase } from "@/components/public-law-table/public-law-results-state.logic";

/** The deepest page a request may address at this page size. */
export const caseLawDeepestPage = (pageSize: PublicLawPageSize): number =>
  Math.floor(CASE_LAW_RESULT_DEPTH_MAX / pageSize);

/**
 * The deepest page at any offered size: how far a URL's page is read before
 * its size is applied.
 */
export const CASE_LAW_MAX_PAGE = Math.max(
  ...PUBLIC_LAW_PAGE_SIZES.map((pageSize) => caseLawDeepestPage(pageSize)),
);

/**
 * The page a case-law URL names, at its page size. A page past the deepest
 * one is the deepest, so a link written at a smaller size still lands as deep
 * as this size allows.
 */
export const caseLawPageNumber = (
  page: number | undefined,
  pageSize: PublicLawPageSize,
): number =>
  Math.min(
    publicLawPageNumber(page, CASE_LAW_MAX_PAGE),
    caseLawDeepestPage(pageSize),
  );

type CaseLawPageBeforeEndInput = {
  /** The page that came back empty; always past the first. */
  emptyPage: number;
  pageSize: PublicLawPageSize;
  /** The result set's total, as its first page reported it. */
  total: SearchTotal;
};

/**
 * Where a link to a page past the results' end lands: the last page the total
 * says holds rows, and always a page before the empty one, so a total that
 * overstates the results cannot send the reader back to the same empty page.
 */
export const caseLawPageBeforeEnd = ({
  emptyPage,
  pageSize,
  total,
}: CaseLawPageBeforeEndInput): number => {
  const lastWithRows =
    total.type === SEARCH_TOTAL_TYPE.NOT_COUNTED
      ? 1
      : Math.ceil(total.count / pageSize);
  return Math.max(1, Math.min(lastWithRows, emptyPage - 1));
};

type CaseLawLandingPageInput = {
  /** The page a link or a pager button named. */
  wanted: number;
  pageSize: PublicLawPageSize;
  /** The result set's total, as its first page reported it. */
  total: SearchTotal;
  /**
   * How many rows a page holds, or null when the search could not be read:
   * an outage proves nothing about which pages exist.
   */
  rowsOn: (page: number) => Promise<number | null>;
};

/**
 * The page a navigation lands on: the page it named when that page holds
 * rows, otherwise the deepest page before it that does. An estimate can
 * overstate the results, so an empty page steps back to the last page the
 * count fills, and on until a page with rows answers. Each step is one read
 * and the walk never goes deeper than the page named, which the depth bound
 * already caps.
 */
export const caseLawLandingPage = async ({
  pageSize,
  rowsOn,
  total,
  wanted,
}: CaseLawLandingPageInput): Promise<number> => {
  let page = wanted;
  while (page > 1) {
    // Sequential by nature: whether to read the page before this one depends
    // on this one coming back empty.
    const rows = await rowsOn(page);
    if (rows === null || rows > 0) {
      return page;
    }
    page = caseLawPageBeforeEnd({ emptyPage: page, pageSize, total });
  }
  return 1;
};

type CaseLawPageRestInput = {
  /** The page query's data; it may still be another page's while one loads. */
  page: { hasMore: boolean } | undefined;
  rows: PublicLawRowsPhase;
};

/**
 * What follows the page on screen, read only from that page's own answer:
 * rows kept from another page while this one loads say nothing about it.
 */
export const caseLawPageRest = ({
  page,
  rows,
}: CaseLawPageRestInput): PublicLawPageRest => {
  if (rows !== "rows" || page === undefined) {
    return PUBLIC_LAW_PAGE_REST.unknown;
  }
  return page.hasMore ? PUBLIC_LAW_PAGE_REST.more : PUBLIC_LAW_PAGE_REST.end;
};
