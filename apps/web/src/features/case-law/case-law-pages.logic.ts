/**
 * Which pages of a case-law result list exist. Both result endpoints take an
 * offset, bounded by the depth the API serves (`CASE_LAW_RESULT_DEPTH_MAX`,
 * shared with the API rather than copied), so the deepest page depends only
 * on the page size.
 */

import { CASE_LAW_RESULT_DEPTH_MAX } from "@stll/api-contract/limits";
import { SEARCH_TOTAL_TYPE, type SearchTotal } from "@stll/api-contract/search";

import {
  PUBLIC_LAW_PAGE_SIZES,
  publicLawPageNumber,
  type PublicLawPageSize,
} from "@/components/public-law-table/public-law-pagination.logic";

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
