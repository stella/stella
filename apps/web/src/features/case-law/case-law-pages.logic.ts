/**
 * Which pages of a case-law result list exist. Both result endpoints take an
 * offset, bounded by the depth the API serves (`CASE_LAW_RESULT_DEPTH_MAX`,
 * shared with the API rather than copied), so the deepest page depends only
 * on the page size.
 */

import { panic } from "better-result";

import { CASE_LAW_RESULT_DEPTH_MAX } from "@stll/api-contract/limits";
import {
  SEARCH_PAGE_REACH,
  SEARCH_TOTAL_TYPE,
  type SearchPageReach,
  type SearchTotal,
} from "@stll/api-contract/search";

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

/**
 * What reading one page proved about where the results end. Only the page's
 * own end signal decides: its row count never does, because a page can be
 * short without being the last (decisions a reference pins are dropped from
 * every text page they would have appeared on).
 */
export type CaseLawPageEvidence =
  /** The read failed, or the search could not place the page: no proof. */
  | { type: "unknown" }
  /** The page holds nothing: the results end before it. */
  | { type: "empty" }
  /** The page holds rows; `rest` says whether the search reported more. */
  | { type: "rows"; rest: "more" | "end" };

type CaseLawLandingPageInput = {
  /** The page a link or a pager button named. */
  wanted: number;
  pageSize: PublicLawPageSize;
  /** The result set's total, as its first page reported it. */
  total: SearchTotal;
  /** What reading a page proves; an outage proves nothing. */
  evidenceOn: (page: number) => Promise<CaseLawPageEvidence>;
};

/**
 * The page a navigation lands on: the page it named when that page holds
 * rows, otherwise the deepest page before it that does.
 *
 * The count says where to look first, but an estimate can overstate or
 * understate the results and a listing may not be counted at all, so the
 * last page with rows is searched for between the deepest page known to hold
 * rows (the first, until a read says otherwise) and the shallowest page known
 * to be empty. A page whose answer reports no more results is the last one,
 * so the search stops there. Reads are sequential by nature, each deciding
 * the next, and number at most two plus the halvings between the first page
 * and the page named, which the depth bound caps. A read that proves nothing
 * keeps the page the navigation named.
 */
export const caseLawLandingPage = async ({
  evidenceOn,
  pageSize,
  total,
  wanted,
}: CaseLawLandingPageInput): Promise<number> => {
  if (wanted <= 1) {
    return 1;
  }
  if ((await evidenceOn(wanted)).type !== "empty") {
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
    const evidence = await evidenceOn(probe);
    switch (evidence.type) {
      case "unknown":
        return wanted;
      case "empty":
        empty = probe;
        break;
      case "rows":
        if (evidence.rest === "end") {
          return probe;
        }
        holding = probe;
        break;
      default:
        evidence satisfies never;
        return panic("Unhandled page evidence");
    }
    probe = Math.floor((holding + empty) / 2);
  }
  return holding;
};

/** What a page's own answer says about the results around it. */
type CaseLawPageAnswer = {
  hasMore: boolean;
  /** Whether the search placed the page at all (`SEARCH_PAGE_REACH`). */
  reach: SearchPageReach;
};

/**
 * What a page's answer proves about where the results end: nothing for a
 * page the search could not place, whose rows (however few) prove nothing;
 * otherwise empty, or rows with the search's own word on whether more follow.
 */
export const caseLawPageEvidence = (
  page: CaseLawPageAnswer & { decisions: readonly unknown[] },
): CaseLawPageEvidence => {
  if (page.reach === SEARCH_PAGE_REACH.SCAN_BUDGET) {
    return { type: "unknown" };
  }
  if (page.decisions.length === 0) {
    return { type: "empty" };
  }
  return { type: "rows", rest: page.hasMore ? "more" : "end" };
};

type CaseLawPageRestInput = {
  /** The page query's data; it may still be another page's while one loads. */
  page: CaseLawPageAnswer | undefined;
  rows: PublicLawRowsPhase;
};

/**
 * What follows the page on screen, read only from that page's own answer:
 * rows kept from another page while this one loads say nothing about it, and
 * neither does a page the search could not place.
 */
export const caseLawPageRest = ({
  page,
  rows,
}: CaseLawPageRestInput): PublicLawPageRest => {
  if (
    rows !== "rows" ||
    page === undefined ||
    page.reach === SEARCH_PAGE_REACH.SCAN_BUDGET
  ) {
    return PUBLIC_LAW_PAGE_REST.unknown;
  }
  return page.hasMore ? PUBLIC_LAW_PAGE_REST.more : PUBLIC_LAW_PAGE_REST.end;
};
