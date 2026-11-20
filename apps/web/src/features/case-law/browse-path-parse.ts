import { panic, Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { CASE_LAW_BROWSE_MAX_PAGES } from "@stll/api-contract/case-law-browse-hubs";
import { Temporal } from "@stll/time";

import {
  caseLawBrowseCourtSegment,
  type CaseLawBrowseListing,
  type CaseLawBrowseTarget,
} from "./browse-path";

/**
 * Reading a browse address back into the page it names, and the dates a
 * listing covers. Only the hub routes' loaders read these, so they stay out
 * of the modules every page's head and links load at startup.
 */

const pad2 = (value: number): string => String(value).padStart(2, "0");

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
  // A page past the safe integer range is not found, like one past the cap.
  const page = parseIntegerToken(value, { sign: "unsigned" });
  return Result.isOk(page) && page.value <= CASE_LAW_BROWSE_MAX_PAGES
    ? page.value
    : null;
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
