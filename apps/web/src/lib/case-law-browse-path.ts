import { panic, Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { CASE_LAW_BROWSE_MAX_PAGES } from "@stll/api-contract/case-law-browse-hubs";
import { createCaseLawDecisionSlug } from "@stll/api-contract/case-law-decision-route";
import { Temporal } from "@stll/time";

import {
  publicCaseLawPageCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";

/**
 * The crawlable browse tree of a jurisdiction's decisions, as query-free
 * paths. Each level links to the next, so a crawler reaches every listed
 * decision from `/law/{country}` by plain links:
 *
 *   /law/{country}                                  courts
 *   /law/{country}/courts/{court}                   years
 *   /law/{country}/courts/{court}/{yyyy}            months
 *   /law/{country}/courts/{court}/{yyyy}/{mm}       decisions, or days when
 *                                                   the month is too large
 *   /law/{country}/courts/{court}/{yyyy}/{mm}/{dd}  decisions
 *   .../page/{n}                                    listing page n (n >= 2)
 *
 * Decisions without a date sort outside every period, so the tree does not
 * reach them; the per-month sitemaps list them.
 *
 * Only the canonical spelling parses: a page address has exactly one URL.
 */

export type CaseLawBrowseTarget =
  | { level: "court"; court: string }
  | { level: "year"; court: string; year: number }
  | { level: "month"; court: string; year: number; month: number; page: number }
  | {
      level: "day";
      court: string;
      year: number;
      month: number;
      day: number;
      page: number;
    };

/** A listing level: one that pages through decisions. */
export type CaseLawBrowseListing = Extract<
  CaseLawBrowseTarget,
  { page: number }
>;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** The court's URL segment: the same fold its decisions' URLs carry. */
export const caseLawBrowseCourtSegment = (court: string): string =>
  createCaseLawDecisionSlug(court);

export const createCaseLawJurisdictionHubPath = (
  countryParam: string,
): `/law/${string}` => `/law/${countryParam}`;

/**
 * The hub a search, filter or home URL scoped to `country` stands in for, or
 * null when the country has no public pages.
 */
export const publicCaseLawHubPathFor = (
  country: string | undefined,
): `/law/${string}` | null => {
  const scope =
    country === undefined ? null : publicCaseLawPageCountryFromParam(country);
  return scope === null
    ? null
    : createCaseLawJurisdictionHubPath(toCaseLawCountryParam(scope));
};

const pageSuffix = (page: number): string =>
  page > 1 ? `/page/${String(page)}` : "";

export const createCaseLawBrowsePath = (
  countryParam: string,
  target: CaseLawBrowseTarget,
): `/law/${string}` => {
  const court: `/law/${string}` = `/law/${countryParam}/courts/${target.court}`;
  switch (target.level) {
    case "court":
      return `/law/${countryParam}/courts/${target.court}`;
    case "year":
      return `${court}/${String(target.year)}`;
    case "month":
      return `${court}/${String(target.year)}/${pad2(target.month)}${pageSuffix(target.page)}`;
    case "day":
      return `${court}/${String(target.year)}/${pad2(target.month)}/${pad2(target.day)}${pageSuffix(target.page)}`;
    default:
      target satisfies never;
      return panic("Unhandled browse level");
  }
};

const YEAR = /^[1-9]\d{3}$/u;
const TWO_DIGITS = /^\d{2}$/u;
const PAGE = /^[2-9]\d*$|^[1-9]\d+$/u;

/** A segment the patterns above admitted, as its number. */
const segmentNumber = (segment: string): number => {
  const parsed = parseIntegerToken(segment, { sign: "unsigned" });
  return Result.isOk(parsed)
    ? parsed.value
    : panic("An admitted segment is a number");
};

const readPage = (segments: readonly string[]): number | null => {
  if (segments.length === 0) {
    return 1;
  }
  const [word, value, ...rest] = segments;
  if (word !== "page" || value === undefined || rest.length > 0) {
    return null;
  }
  if (!PAGE.test(value)) {
    return null;
  }
  const page = segmentNumber(value);
  return page <= CASE_LAW_BROWSE_MAX_PAGES ? page : null;
};

const daysInMonth = (year: number, month: number): number =>
  Temporal.PlainYearMonth.from({ year, month }).daysInMonth;

/** The target a splat under `/law/{country}/courts/` names, or null. */
export const parseCaseLawBrowseSplat = (
  splat: string,
): CaseLawBrowseTarget | null => {
  const [court, second, third, fourth, ...rest] = splat.split("/");
  if (!court || caseLawBrowseCourtSegment(court) !== court) {
    return null;
  }
  if (second === undefined) {
    return third === undefined ? { level: "court", court } : null;
  }
  if (!YEAR.test(second)) {
    return null;
  }
  const year = segmentNumber(second);
  if (third === undefined) {
    return { level: "year", court, year };
  }
  if (!TWO_DIGITS.test(third)) {
    return null;
  }
  const month = segmentNumber(third);
  if (month < 1 || month > 12) {
    return null;
  }
  if (fourth === undefined || fourth === "page") {
    const page = readPage(
      [fourth, ...rest].filter((s): s is string => s !== undefined),
    );
    return page === null ? null : { level: "month", court, year, month, page };
  }
  if (!TWO_DIGITS.test(fourth)) {
    return null;
  }
  const day = segmentNumber(fourth);
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  const page = readPage(rest);
  return page === null ? null : { level: "day", court, year, month, day, page };
};

/** The decision-date range one listing level covers, both ends inclusive. */
export const caseLawBrowseDateRange = (
  target: CaseLawBrowseListing,
): { dateFrom: string; dateTo: string } => {
  const prefix = `${String(target.year)}-${pad2(target.month)}`;
  if (target.level === "day") {
    const date = `${prefix}-${pad2(target.day)}`;
    return { dateFrom: date, dateTo: date };
  }
  return {
    dateFrom: `${prefix}-01`,
    dateTo: `${prefix}-${pad2(daysInMonth(target.year, target.month))}`,
  };
};
