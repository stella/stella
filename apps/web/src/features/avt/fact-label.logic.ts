/**
 * How an anchor fact's name reads in the record. Imported facts often carry
 * their exhibit reference and a "date (source):" lead-in inside the name
 * ("CAL-01: 9 Mar 2021 (Outlook export p.14): Calendar invitation …"), which
 * the row already shows from the structured fields. The reference becomes a
 * quiet label; the lead-in is dropped only when its date is exactly the
 * recorded date (at the recorded precision) and its source is exactly the
 * recorded medium, so nothing the fields do not show is ever hidden.
 */

import type { FactDatePrecision } from "@/features/avt/types";

export type FactLabel = {
  reference: string | null;
  statement: string;
};

type RecordedFields = {
  medium: string | null;
  occurredOn: string | null;
  precision: FactDatePrecision | null;
};

/** An exhibit-style reference: "CAL-01", "BANK-02", "EM-4a", "WS_12". */
const REFERENCE_PREFIX = /^([A-Z][A-Z0-9]*[-_.][A-Z0-9]+[a-z]?):\s+/u;

export const factLabel = (
  name: string,
  recorded: RecordedFields,
): FactLabel => {
  const match = REFERENCE_PREFIX.exec(name);
  const reference = match?.[1] ?? null;
  const rest = match === null ? name : name.slice(match[0].length);
  return { reference, statement: withoutSourceLeadIn(rest, recorded) };
};

const withoutSourceLeadIn = (
  text: string,
  { medium, occurredOn, precision }: RecordedFields,
): string => {
  if (
    medium === null ||
    medium === "" ||
    occurredOn === null ||
    precision === null
  ) {
    return text;
  }
  const marker = ` (${medium}): `;
  const index = text.indexOf(marker);
  if (index <= 0) {
    return text;
  }
  const leadIn = parseLeadInDate(text.slice(0, index));
  if (leadIn === null || !sameDate(leadIn, occurredOn, precision)) {
    return text;
  }
  const statement = text.slice(index + marker.length);
  return statement === "" ? text : statement;
};

type LeadInDate = {
  year: number;
  month: number | null;
  day: number | null;
};

/** English month words in calendar order, abbreviated or in full. */
const MONTH_WORDS = [
  /^jan(?:uary)?$/iu,
  /^feb(?:ruary)?$/iu,
  /^mar(?:ch)?$/iu,
  /^apr(?:il)?$/iu,
  /^may$/iu,
  /^jun(?:e)?$/iu,
  /^jul(?:y)?$/iu,
  /^aug(?:ust)?$/iu,
  /^sep(?:tember)?$/iu,
  /^oct(?:ober)?$/iu,
  /^nov(?:ember)?$/iu,
  /^dec(?:ember)?$/iu,
];

/** 1-12 for "Mar", "Mar.", "March" (any case); null for anything else. */
const monthNumber = (word: string): number | null => {
  const bare = word.replace(/\.$/u, "");
  const index = MONTH_WORDS.findIndex((pattern) => pattern.test(bare));
  return index === -1 ? null : index + 1;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DAY_MONTH_YEAR = /^(\d{1,2}) ([A-Za-z]+\.?) (\d{4})$/u;
const MONTH_DAY_YEAR = /^([A-Za-z]+\.?) (\d{1,2}), (\d{4})$/u;
const MONTH_YEAR = /^([A-Za-z]+\.?) (\d{4})$/u;
const YEAR = /^(\d{4})$/u;

/** A lead-in that is a date and nothing else, or null. */
const parseLeadInDate = (text: string): LeadInDate | null => {
  const iso = ISO_DATE.exec(text);
  if (iso !== null) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
    };
  }
  const dayFirst = DAY_MONTH_YEAR.exec(text);
  if (dayFirst !== null) {
    const month = monthNumber(dayFirst[2] ?? "");
    return month === null
      ? null
      : { year: Number(dayFirst[3]), month, day: Number(dayFirst[1]) };
  }
  const monthFirst = MONTH_DAY_YEAR.exec(text);
  if (monthFirst !== null) {
    const month = monthNumber(monthFirst[1] ?? "");
    return month === null
      ? null
      : { year: Number(monthFirst[3]), month, day: Number(monthFirst[2]) };
  }
  const monthYear = MONTH_YEAR.exec(text);
  if (monthYear !== null) {
    const month = monthNumber(monthYear[1] ?? "");
    return month === null
      ? null
      : { year: Number(monthYear[2]), month, day: null };
  }
  const year = YEAR.exec(text);
  return year === null
    ? null
    : { year: Number(year[1]), month: null, day: null };
};

/** The lead-in names the recorded date, no more and no less precisely. */
const sameDate = (
  leadIn: LeadInDate,
  occurredOn: string,
  precision: FactDatePrecision,
): boolean => {
  const recorded = ISO_DATE.exec(occurredOn);
  if (recorded === null) {
    return false;
  }
  const month = precision === "year" ? null : Number(recorded[2]);
  const day = precision === "day" ? Number(recorded[3]) : null;
  return (
    leadIn.year === Number(recorded[1]) &&
    leadIn.month === month &&
    leadIn.day === day
  );
};
