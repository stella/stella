import { sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

/**
 * Compare-and-set token for a `timestamp` column.
 *
 * Postgres stores microseconds while a JS `Date` carries milliseconds, so
 * reading a timestamp into a `Date` and comparing it back silently narrows
 * the value: a row whose timestamp came from SQL `now()` can never match,
 * and the guarded write no-ops without an error. The token is the column's
 * exact text form; treat it as opaque and only feed it back through
 * {@link timestampMatchesCasToken} (or an equivalent `::timestamp` cast in
 * hand-built statements).
 */
export type TimestampCasToken = string & {
  readonly __timestampCasToken: "TimestampCasToken";
};

/** Select expression producing the column's exact-precision CAS token. */
export const timestampCasToken = (column: AnyColumn): SQL<TimestampCasToken> =>
  sql<TimestampCasToken>`${column}::text`;

/** WHERE fragment comparing the column against a previously selected token. */
export const timestampMatchesCasToken = (
  column: AnyColumn,
  token: TimestampCasToken,
): SQL => sql`${column} IS NOT DISTINCT FROM ${token}::timestamp`;
