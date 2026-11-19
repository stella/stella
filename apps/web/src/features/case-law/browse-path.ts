import { panic } from "better-result";

import { createCaseLawDecisionSlug } from "@stll/api-contract/case-law-decision-route";
import { Temporal } from "@stll/time";

import {
  publicCaseLawPageCountryFromParam,
  toCaseLawCountryParam,
} from "./case-law-jurisdiction";

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
 * Only the canonical spelling parses (`browse-path-parse.ts`, which only the
 * hub routes' loaders read): a page address has exactly one URL.
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

/** Whether a route's parsed search carries any parameter at all. */
export const hasSearch = (search: object): boolean =>
  Object.keys(search).length > 0;

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

/**
 * The part of the page's formatter the labels use. Kept structural so the
 * projects that import the browse paths from outside the app (the e2e
 * helpers) type-check them without pulling in the app's i18n store.
 */
type Formatter = {
  dateTime: (value: number, options: CaseLawBrowsePeriodFormat) => string;
};

/** The two ways a period is named: a month with its year, or a whole day. */
type CaseLawBrowsePeriodFormat =
  | { month: "long"; timeZone: "UTC"; year: "numeric" }
  | { dateStyle: "long"; timeZone: "UTC" };

/** A calendar day as the instant its UTC midnight is, for the formatter. */
const utcDay = (year: number, month: number, day = 1): number =>
  Temporal.PlainDate.from({ year, month, day }).toZonedDateTime("UTC")
    .epochMilliseconds;

/** A month as the page's language names it, with its year. */
export const caseLawBrowseMonthLabel = (
  format: Formatter,
  year: number,
  month: number,
) =>
  format.dateTime(utcDay(year, month), {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });

/** The period a page covers, as the page's language names it. */
export const caseLawBrowsePeriodLabel = (
  format: Formatter,
  target: CaseLawBrowseTarget,
): string | null => {
  switch (target.level) {
    case "court":
      return null;
    case "year":
      return String(target.year);
    case "month":
      return caseLawBrowseMonthLabel(format, target.year, target.month);
    case "day":
      return format.dateTime(utcDay(target.year, target.month, target.day), {
        dateStyle: "long",
        timeZone: "UTC",
      });
    default:
      target satisfies never;
      return panic("Unhandled browse level");
  }
};
