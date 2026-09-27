import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import { SanctionsListParseError } from "./entry";
import type { BirthDate, SanctionsSource } from "./entry";

// xsd:date, which may carry a timezone suffix ("2015-07-01-04:00").
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:Z|[+-]\d{2}:\d{2})?$/u;
const INTEGER = /^\d{1,4}$/u;

export const invalidValue = (
  source: SanctionsSource,
  message: string,
): SanctionsListParseError =>
  new SanctionsListParseError({ code: "invalid-value", message, source });

export const missingField = (
  source: SanctionsSource,
  message: string,
): SanctionsListParseError =>
  new SanctionsListParseError({ code: "missing-field", message, source });

type IsoDateParts = { year: number; month: number; day: number };

/** Whether the day exists in the proleptic Gregorian calendar. */
export const isCalendarDate = ({ year, month, day }: IsoDateParts): boolean =>
  Result.try(() =>
    Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" }),
  ).isOk();

/** Parses a calendar date written as YYYY-MM-DD and rejects impossible days. */
export const parseIsoDate = (
  source: SanctionsSource,
  value: string,
): Result<IsoDateParts, SanctionsListParseError> => {
  const match = ISO_DATE.exec(value);
  if (match === null) {
    return Result.err(
      invalidValue(source, `"${value}" is not a YYYY-MM-DD date`),
    );
  }
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  if (!isCalendarDate(parts)) {
    return Result.err(
      invalidValue(source, `"${value}" is not a calendar date`),
    );
  }
  return Result.ok(parts);
};

/** A listed birth date given to the day. */
export const parseDayBirthDate = (
  source: SanctionsSource,
  value: string,
  circa: boolean,
): Result<BirthDate, SanctionsListParseError> =>
  parseIsoDate(source, value).map(({ year, month, day }): BirthDate => ({
    precision: "day",
    year,
    month,
    day,
    circa,
  }));

/** A validated date as YYYY-MM-DD, dropping any timezone suffix. */
export const isoDate = (
  source: SanctionsSource,
  value: string,
): Result<string, SanctionsListParseError> =>
  parseIsoDate(source, value).map(({ year, month, day }) =>
    [
      String(year).padStart(4, "0"),
      String(month).padStart(2, "0"),
      String(day).padStart(2, "0"),
    ].join("-"),
  );

export const parseSmallInteger = (
  source: SanctionsSource,
  value: string,
): Result<number, SanctionsListParseError> =>
  INTEGER.test(value)
    ? Result.ok(Number(value))
    : Result.err(invalidValue(source, `"${value}" is not a whole number`));
