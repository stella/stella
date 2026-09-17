/**
 * The decision date a citation names, read from the citing sentence.
 *
 * One docket names a whole case file, and a court can rule in it more than
 * once: `8 As 287/2020` carries three decisions in the corpus. The docket
 * alone therefore does not identify a decision, and the resolver's uniqueness
 * rule cannot pick one of them. The citing sentence usually says which:
 * "rozsudek Nejvyššího správního soudu ze dne 17. 2. 2021, č. j. 8 As
 * 287/2020-33". The extractor's number pattern keeps the docket and drops the
 * date; this keeps the date, as the resolver's own `date` type, to compare
 * against each candidate's `decision_date`.
 *
 * Conservative by construction: a sentence whose date the pattern does not
 * recognise, or whose date is not a real calendar day, yields no hint rather
 * than a wrong one.
 */

import { Temporal } from "@stll/time";

/** `ze dne 21. 5. 2025`, `zo dňa 25. 3. 2015`, `z 12. 1. 2020`. */
export const DECISION_DATE_SOURCE = String.raw`\s+(?:ze|zo|z)\s+(?:d[nň][eaě]\s+)?(?<day>\d{1,2})\.\s*(?<month>\d{1,2})\.\s*(?<year>\d{4})`;

/** What the extractor's number pattern starts right after. */
export const CITATION_MARKER_SOURCE = String.raw`(?:č\.\s*j\.|čj\.|sp\.\s*zn\.|spis\.\s*zn\.|sen\.\s*zn\.)`;

/**
 * How far before the number the date may begin. "ze dne 17. 2. 2021, č. j."
 * is under forty characters; the bound keeps a date belonging to an earlier
 * clause in the same sentence from binding to this citation.
 */
const DATE_WINDOW_CHARS = 48;

/**
 * The date bound to the citation, anchored at the end of the window so only a
 * date that runs straight into the citation marker can bind. The marker is
 * optional because a bare docket ("nález ze dne 1. 11. 2017, I. ÚS 1135/17")
 * is cited without one.
 */
const DATE_BEFORE_CITATION = new RegExp(
  String.raw`${DECISION_DATE_SOURCE},?\s*(?:${CITATION_MARKER_SOURCE})?\s*$`,
  "u",
);

/**
 * The date as an ISO calendar day, or null when the parts do not name one.
 *
 * Measured against the calendar rather than range-checked by hand, so
 * "31. 2. 2021" is rejected the same way "45. 1. 2021" is: a day the month
 * does not have is a misread, and a hint the resolver compares against a real
 * `decision_date` must not be one. Month and day are bounded first, which is
 * what keeps both `Temporal` constructions from rejecting their input.
 */
const isoDayOf = (day: number, month: number, year: number): string | null => {
  if (month < 1 || month > 12 || day < 1) {
    return null;
  }
  const { daysInMonth } = Temporal.PlainYearMonth.from({ month, year });
  return day > daysInMonth
    ? null
    : Temporal.PlainDate.from({ day, month, year }).toString();
};

/**
 * The decision date the sentence introduces the citation starting at
 * `matchIndex` with, as `YYYY-MM-DD`, or null when it names none.
 */
export const detectCitationDecisionDate = (
  text: string,
  matchIndex: number,
): string | null => {
  const windowStart = Math.max(0, matchIndex - DATE_WINDOW_CHARS);
  const groups = DATE_BEFORE_CITATION.exec(
    text.slice(windowStart, matchIndex),
  )?.groups;
  const day = groups?.["day"];
  const month = groups?.["month"];
  const year = groups?.["year"];
  if (day === undefined || month === undefined || year === undefined) {
    return null;
  }
  return isoDayOf(Number(day), Number(month), Number(year));
};
