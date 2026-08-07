import { sql } from "drizzle-orm";
import type { AnyColumn, Column, SQL } from "drizzle-orm";

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
