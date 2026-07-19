import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Column, SQL, SQLWrapper } from "drizzle-orm";

import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";

const PG_TIMESTAMP_CURSOR_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})\.(?<microseconds>\d{6})$/u;
const LEGACY_ISO_CURSOR_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})\.(?<milliseconds>\d{3})Z$/u;
const THIRTY_DAY_MONTHS = new Set([4, 6, 9, 11]);

/**
 * `microseconds` is the canonical `to_char(..., '...US')` projection this codec
 * emits today; `milliseconds` marks a legacy `date_trunc('milliseconds', ...)`
 * cursor (ISO `…​.123Z`) issued before the microsecond migration. Keyset
 * comparisons truncate the column to match a `milliseconds` boundary so a page
 * cut before the migration resumes without duplicating or skipping the rows
 * that shared its truncated millisecond.
 */
export type PgTimestampCursorPrecision = "microseconds" | "milliseconds";

export type ParsedPgTimestampCursor = {
  type: "pgTimestampCursor";
  value: string;
  precision: PgTimestampCursorPrecision;
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

  const canonical = PG_TIMESTAMP_CURSOR_PATTERN.exec(value);
  if (canonical && hasValidTimestampParts(canonical.groups)) {
    return { type: "pgTimestampCursor", value, precision: "microseconds" };
  }

  const legacy = LEGACY_ISO_CURSOR_PATTERN.exec(value);
  if (legacy && hasValidTimestampParts(legacy.groups)) {
    return { type: "pgTimestampCursor", value, precision: "milliseconds" };
  }

  return null;
};

// ── (timestamp, id) keyset cursor codec ──────────────
//
// The `(created_at, id)` (or `(updated_at, id)`) keyset cursor is the same
// shape everywhere: project a microsecond-precision timestamp for
// serialization, keep ordering on the indexed column, and compare against a
// `value::timestamp` boundary. This factory owns that codec so each list
// handler only supplies the timestamp column and the branded-id constructor.

const LEGACY_PIPE_SEPARATOR = "|";

export type TimestampIdCursor<Id> = {
  timestamp: ParsedPgTimestampCursor;
  id: Id;
};

/**
 * `ascending` pages forward (`ORDER BY column, id`, keyset `>`); `descending`
 * pages backward (`ORDER BY column DESC, id DESC`, keyset `<`). The codec owns
 * the whole keyset predicate so no handler can mismatch the boundary column,
 * the tie-break, or the legacy-millisecond truncation across the two clauses.
 */
export type KeysetCursorDirection = "ascending" | "descending";

type KeysetAfterOptions<Id> = {
  cursor: TimestampIdCursor<Id>;
  /** Tie-break id column, ordered after the timestamp column. */
  idColumn: Column;
  direction: KeysetCursorDirection;
};

export type TimestampIdCursorCodec<Id> = {
  /**
   * Microsecond-precision timestamp projected into the row for serialization.
   * Alias it in the `select` (`.as("created_at_cursor")`) and hand the aliased
   * value to `encode`. Ordering stays on the underlying column.
   */
  cursorValue: SQL<string>;
  /**
   * Full keyset predicate selecting the rows strictly after `cursor` in
   * `direction`, on the codec's timestamp column plus `idColumn`. Canonical
   * microsecond cursors compare the raw column; a legacy millisecond cursor
   * compares `date_trunc('milliseconds', column)` on both sides of the
   * comparison so the page it was cut from resumes exactly.
   */
  keysetAfter: (options: KeysetAfterOptions<Id>) => SQL | undefined;
  encode: (timestampValue: string, id: string) => string;
  decode: (cursor: string) => TimestampIdCursor<Id> | null;
};

type TimestampIdCursorCodecOptions<Id> = {
  column: SQLWrapper;
  brandId: (id: string) => Id;
};

// Accepts the canonical base64url JSON tuple and, as a fallback, the legacy
// plain `"timestamp|uuid"` form so cursors issued before the codec was unified
// keep decoding. base64url never contains `|`, and the timestamp half always
// contains `:`/`-` (outside the base64url alphabet), so the two forms cannot be
// confused.
const timestampIdCursorTuple = (cursor: string): [unknown, unknown] | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts !== null) {
    return parts.length === 2 ? [parts[0], parts[1]] : null;
  }

  const separatorIndex = cursor.indexOf(LEGACY_PIPE_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }
  return [cursor.slice(0, separatorIndex), cursor.slice(separatorIndex + 1)];
};

export const createTimestampIdCursorCodec = <Id>({
  column,
  brandId,
}: TimestampIdCursorCodecOptions<Id>): TimestampIdCursorCodec<Id> => ({
  cursorValue: pgTimestampCursorValue(column),
  keysetAfter: ({ cursor, idColumn, direction }) => {
    const boundary = pgTimestampCursorBoundary(cursor.timestamp);
    const compare = direction === "ascending" ? gt : lt;
    // A legacy millisecond cursor was cut from a page ordered on the
    // millisecond-truncated timestamp, so compare the truncated column against
    // it; a canonical microsecond cursor compares the raw column directly.
    const timestampExpr =
      cursor.timestamp.precision === "milliseconds"
        ? sql`date_trunc('milliseconds', ${column})`
        : column;
    return or(
      compare(timestampExpr, boundary),
      and(eq(timestampExpr, boundary), compare(idColumn, cursor.id)),
    );
  },
  encode: (timestampValue, id) => encodePaginationCursor([timestampValue, id]),
  decode: (cursor) => {
    const tuple = timestampIdCursorTuple(cursor);
    if (tuple === null) {
      return null;
    }
    const [rawTimestamp, rawId] = tuple;
    const timestamp = parsePgTimestampCursorValue(rawTimestamp);
    if (timestamp === null || !isUuidPaginationCursorPart(rawId)) {
      return null;
    }
    return { timestamp, id: brandId(rawId) };
  },
});
