import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

const PG_TIMESTAMP_CURSOR_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})\.(?<microseconds>\d{6})$/u;
const LEGACY_ISO_CURSOR_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})\.(?<milliseconds>\d{3})Z$/u;
const THIRTY_DAY_MONTHS = new Set([4, 6, 9, 11]);

export type ParsedPgTimestampCursor = {
  type: "pgTimestampCursor";
  value: string;
};

/**
 * Selects a timestamp in a stable, microsecond-precision format suitable for
 * opaque cursors. Ordering remains on the original indexed column; this
 * expression is only projected for serialization.
 */
export const pgTimestampCursorValue = (column: SQLWrapper): SQL<string> =>
  sql<string>`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/** Parameterized timestamp boundary used by keyset comparisons. */
export const pgTimestampCursorBoundary = ({
  value,
}: ParsedPgTimestampCursor): SQL<Date> => sql<Date>`${value}::timestamp`;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return THIRTY_DAY_MONTHS.has(month) ? 30 : 31;
};

const hasValidTimestampParts = (groups: Record<string, string> | undefined) => {
  if (groups === undefined) {
    return false;
  }
  const year = Number(groups["year"]);
  const month = Number(groups["month"]);
  const day = Number(groups["day"]);
  const hour = Number(groups["hour"]);
  const minute = Number(groups["minute"]);
  const second = Number(groups["second"]);

  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
};

/**
 * Accepts the canonical PostgreSQL cursor value and the prior ISO form so
 * already-issued cursors continue to work.
 */
export const parsePgTimestampCursorValue = (
  value: unknown,
): ParsedPgTimestampCursor | null => {
  if (typeof value !== "string") {
    return null;
  }

  const match =
    PG_TIMESTAMP_CURSOR_PATTERN.exec(value) ??
    LEGACY_ISO_CURSOR_PATTERN.exec(value);
  if (!match || !hasValidTimestampParts(match.groups)) {
    return null;
  }

  return { type: "pgTimestampCursor", value };
};
