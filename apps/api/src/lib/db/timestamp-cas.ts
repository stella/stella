import { sql } from "drizzle-orm";
import type { AnyColumn, Column, SQL } from "drizzle-orm";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

/**
 * Compare-and-set token for a `timestamp` column.
 *
 * Postgres stores microseconds while a JS `Date` carries milliseconds, so
 * reading a timestamp into a `Date` and comparing it back silently narrows
 * the value: a row whose timestamp came from SQL `now()` can never match,
 * and the guarded write no-ops without an error. The token is the column's
 * exact text form; treat it as opaque and only feed it back through
 * {@link timestampMatchesCasToken} (or an equivalent `::timestamptz` cast in
 * hand-built statements).
 */
export type TimestampCasToken = string & {
  readonly __timestampCasToken: "TimestampCasToken";
};

/**
 * Token type for a column, derived from the column's own nullability so a
 * nullable timestamp cannot be read back as a non-null token.
 */
type ColumnCasToken<TColumn extends Column> =
  TColumn["_"]["notNull"] extends true
    ? TimestampCasToken
    : TimestampCasToken | null;

// `timestamptz::text` under the default ISO DateStyle, offset included, so a
// token read in one session TimeZone still names the same instant in another.
const TIMESTAMP_CAS_TOKEN_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d{1,6})?[+-](?<offsetHour>\d{2})(?::(?<offsetMinute>\d{2}))?(?::(?<offsetSecond>\d{2}))?$/u;

// Postgres rejects a UTC offset of 16 hours or more.
const MAX_OFFSET_HOURS = 15;

const isLeapYear = (year: number) =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number) => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/**
 * Recognises a token a client sent back. A value that fails is not a
 * revision this column ever produced, so it can never match; checking it
 * here keeps it out of the `::timestamptz` cast, which would fail the whole
 * statement on a date or time no calendar has (`2026-02-30`, `25:00`).
 */
export const isTimestampCasToken = (
  value: string,
): value is TimestampCasToken => {
  const fields = TIMESTAMP_CAS_TOKEN_PATTERN.exec(value)?.groups;
  if (fields === undefined) {
    return false;
  }
  // An absent optional field is zero; anything unreadable is NaN, which no
  // range check below accepts.
  const field = (name: string) =>
    parseIntegerToken(fields[name] ?? "0", { sign: "unsigned" }).unwrapOr(
      Number.NaN,
    );
  const year = field("year");
  const month = field("month");
  const day = field("day");
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    field("hour") <= 23 &&
    field("minute") <= 59 &&
    field("second") <= 59 &&
    field("offsetHour") <= MAX_OFFSET_HOURS &&
    field("offsetMinute") <= 59 &&
    field("offsetSecond") <= 59
  );
};

/** The token as the opaque text a client carries and sends back. */
export const timestampCasTokenText = (token: TimestampCasToken): string =>
  token;

/** Select expression producing the column's exact-precision CAS token. */
export const timestampCasToken = <TColumn extends Column>(
  column: TColumn,
): SQL<ColumnCasToken<TColumn>> => sql`${column}::text`;

/**
 * WHERE fragment comparing the column against a previously selected token.
 * A `null` token matches only an unset column, which is what an absent cursor
 * or watermark means.
 */
export const timestampMatchesCasToken = (
  column: AnyColumn,
  token: TimestampCasToken | null,
): SQL => sql`${column} IS NOT DISTINCT FROM ${token}::timestamptz`;
