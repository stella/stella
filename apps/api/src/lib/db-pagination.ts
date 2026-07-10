import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

const PG_TIMESTAMP_CURSOR_PATTERN =
  /^(?<datePart>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(?<microseconds>\d{6})$/u;

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

  const match = PG_TIMESTAMP_CURSOR_PATTERN.exec(value);
  if (match) {
    const datePart = match.groups?.["datePart"];
    const milliseconds = match.groups?.["microseconds"]?.slice(0, 3);
    const date = new Date(`${datePart}.${milliseconds}Z`);
    if (
      datePart !== undefined &&
      milliseconds !== undefined &&
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 23) === value.slice(0, 23)
    ) {
      return { type: "pgTimestampCursor", value };
    }
    return null;
  }

  const legacyDate = new Date(value);
  if (
    Number.isNaN(legacyDate.getTime()) ||
    legacyDate.toISOString() !== value
  ) {
    return null;
  }

  return { type: "pgTimestampCursor", value };
};
