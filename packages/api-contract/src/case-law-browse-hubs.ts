import { CASE_LAW_RESULT_DEPTH_MAX } from "./limits";

/**
 * The crawlable browse tree of public decisions, shared by the API that
 * answers it and the pages that render it.
 */

/** Decisions on one listing page of a court's month or day. */
export const CASE_LAW_BROWSE_PAGE_SIZE = 100;

/**
 * How deep one listing pages: the public listing's own depth bound. A period
 * holding more is split into smaller periods (a month into its days).
 */
export const CASE_LAW_BROWSE_LISTING_DEPTH = CASE_LAW_RESULT_DEPTH_MAX;

/** Listing pages of one period: depth over page size. */
export const CASE_LAW_BROWSE_MAX_PAGES = Math.ceil(
  CASE_LAW_BROWSE_LISTING_DEPTH / CASE_LAW_BROWSE_PAGE_SIZE,
);

/**
 * Courts one jurisdiction hub names. The largest public jurisdiction holds a
 * few hundred; the cap bounds the read, and `truncated` reports a cut.
 */
export const CASE_LAW_BROWSE_COURTS_MAX = 2000;

/** Whether a period's capped count is too large for one listing. */
export const isCaseLawBrowsePeriodSplit = (count: number): boolean =>
  count > CASE_LAW_BROWSE_LISTING_DEPTH;

/**
 * The language versions hub links stand for a multilingual decision by:
 * English, then French, whatever the visitor's language, so a crawler sees
 * one stable link per decision.
 */
export const CASE_LAW_BROWSE_READING_LANGUAGES: readonly string[] = [
  "en",
  "fr",
];
