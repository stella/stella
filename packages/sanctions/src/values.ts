import { Result } from "better-result";

import { Temporal } from "@stll/time";

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
type DayBirthDate = Extract<BirthDate, { precision: "day" }>;

export const parseDayBirthDate = (
  source: SanctionsSource,
  value: string,
  circa: boolean,
): Result<DayBirthDate, SanctionsListParseError> =>
  parseIsoDate(source, value).map(({ year, month, day }) => ({
    precision: "day" as const,
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

/**
 * The instant an edition stamp names: an ISO 8601 instant with an offset, or a
 * calendar date read as the start of that day in UTC. Null for anything else.
 */
export const stampInstant = (stamp: string): Temporal.Instant | null => {
  const instant = Result.try(() => Temporal.Instant.from(stamp)).unwrapOr(null);
  if (instant !== null) {
    return instant;
  }
  return ISO_DATE.test(stamp)
    ? Result.try(() =>
        Temporal.PlainDate.from(stamp.slice(0, 10), { overflow: "reject" })
          .toZonedDateTime("UTC")
          .toInstant(),
      ).unwrapOr(null)
    : null;
};

/** A publisher's edition stamp; anything but an instant or a date is drift. */
export const publisherStamp = (
  source: SanctionsSource,
  value: string,
): Result<string, SanctionsListParseError> =>
  stampInstant(value) === null
    ? Result.err(
        invalidValue(source, `"${value}" is not an ISO 8601 edition stamp`),
      )
    : Result.ok(value);

export const parseSmallInteger = (
  source: SanctionsSource,
  value: string,
): Result<number, SanctionsListParseError> =>
  INTEGER.test(value)
    ? Result.ok(Number(value))
    : Result.err(invalidValue(source, `"${value}" is not a whole number`));
