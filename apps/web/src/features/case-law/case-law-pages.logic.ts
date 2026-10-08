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
 * rows, otherwise the deepest page before it that does.
 *
 * The count says where to look first, but an estimate can overstate or
 * understate the results and a listing may not be counted at all, so the
 * last page with rows is searched for between the deepest page known to hold
 * rows (the first, until a read says otherwise) and the shallowest page known
 * to be empty. A page holding fewer rows than a full page is the last one, so
 * the search stops there. Reads are sequential by nature, each deciding the
 * next, and number at most two plus the halvings between the first page and
 * the page named, which the depth bound caps. An outage proves nothing about
 * which pages exist, so it keeps the page the navigation named.
 */
export const caseLawLandingPage = async ({
  pageSize,
  rowsOn,
  total,
  wanted,
}: CaseLawLandingPageInput): Promise<number> => {
  if (wanted <= 1) {
    return 1;
  }
  const wantedRows = await rowsOn(wanted);
  if (wantedRows === null || wantedRows > 0) {
    return wanted;
  }
  /** Deepest page known to hold rows; the first stands in until one is read. */
  let holding = 1;
  /** Shallowest page known to be empty. */
  let empty = wanted;
  const suggested = caseLawPageBeforeEnd({
    emptyPage: wanted,
    pageSize,
    total,
  });
  let probe =
    suggested > holding ? suggested : Math.floor((holding + empty) / 2);
  while (probe > holding && probe < empty) {
    const rows = await rowsOn(probe);
    if (rows === null) {
      return wanted;
    }
    if (rows === 0) {
      empty = probe;
    } else if (rows < pageSize) {
      return probe;
    } else {
      holding = probe;
    }
    probe = Math.floor((holding + empty) / 2);
  }
  return holding;
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
