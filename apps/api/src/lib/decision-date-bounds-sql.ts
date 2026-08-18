/**
 * `canonicalDecisionDate`'s year bounds, in SQL.
 *
 * Both fragments are derived from `DECISION_YEAR_BOUNDS`, the same declaration
 * the write-path guard reads, so the runtimes cannot drift into disagreeing
 * about which stored dates are impossible. `decision-date-bounds-sql.db.test.ts`
 * proves the agreement executably rather than by inspection, and proves the two
 * fragments are each other's negation.
 *
 * The ceiling is expressed as the first excluded day (1 January of
 * `currentYear + yearsAhead + 1`) rather than a year comparison, so a predicate
 * built from it stays a pair of range scans over `case_law_decisions_date_idx`
 * instead of a sequential scan behind `extract(...)`.
 *
 * `now()` is read in UTC to match the guard's `getUTCFullYear()`: a session
 * time zone must not decide whether a stored date is corrupt.
 *
 * Written with `sql.raw` for the two integers so the fragment is literal SQL
 * with no bind parameters, which is what lets the same text serve in DDL (a
 * CHECK constraint takes no parameters). The values are integers from an
 * `as const` declaration, never input.
 */

import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { DECISION_YEAR_BOUNDS } from "@/api/lib/dates";

/** The `case_law_decisions` CHECK that holds `decisionDateWithinBoundsSql`. */
export const CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT =
  "case_law_decisions_decision_date_bounds";

/** First day the bounds admit. */
const floorSql = sql`make_date(${sql.raw(String(DECISION_YEAR_BOUNDS.min))}, 1, 1)`;

/** First day past the ceiling, relative to the current UTC year. */
const ceilingSql = sql`make_date(
       extract(year from (now() AT TIME ZONE 'UTC'))::int
         + ${sql.raw(String(DECISION_YEAR_BOUNDS.yearsAhead + 1))},
       1, 1)`;

/** True for a date the write-path guard would refuse; NULL for a NULL date. */
export const decisionDateOutOfBoundsSql = (column: SQLWrapper): SQL => sql`(
  ${column} < ${floorSql}
  OR ${column} >= ${ceilingSql}
)`;

/**
 * True for a date the write-path guard accepts; NULL for a NULL date. The
 * negation of `decisionDateOutOfBoundsSql`, spelled out so a CHECK reads as
 * the range it enforces.
 */
export const decisionDateWithinBoundsSql = (column: SQLWrapper): SQL => sql`(
  ${column} >= ${floorSql}
  AND ${column} < ${ceilingSql}
)`;
