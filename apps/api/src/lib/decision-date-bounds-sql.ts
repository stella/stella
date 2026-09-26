/**
 * `canonicalDecisionDate`'s bounds, in SQL.
 *
 * Both fragments are derived from `DECISION_DATE_BOUNDS`, the same declaration
 * the write-path guard reads, so the runtimes cannot drift into disagreeing
 * about which stored dates are impossible. `decision-date-bounds-sql.db.test.ts`
 * proves the agreement executably rather than by inspection, and proves the two
 * fragments are each other's negation.
 *
 * The floor depends on the row's country, and is rendered as one range per
 * distinct floor year rather than as a comparison against a per-row
 * expression: `date < floor` for the lowest floor, then `date < floor AND
 * country IN/NOT IN (…)` for each higher one. Every disjunct is then a range
 * over `decision_date`, so a predicate built from it stays a set of range
 * scans over `case_law_decisions_date_idx` instead of a sequential scan. A
 * country no jurisdiction declares takes the default floor, as it does in the
 * guard.
 *
 * The ceiling is expressed as the first excluded day (the current UTC day plus
 * `daysAhead + 1`) rather than a comparison on parts of the date, for the
 * same reason.
 *
 * `now()` is read in UTC to match the guard's UTC day: a session time zone
 * must not decide whether a stored date is corrupt.
 *
 * Written with `sql.raw` for the integers and the country codes so the
 * fragment is literal SQL with no bind parameters, which is what lets the same
 * text serve in DDL (a CHECK constraint takes no parameters). The values come
 * from an `as const` declaration, never input.
 */

import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

import {
  CASE_LAW_JURISDICTIONS,
  type CaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";

import { DECISION_DATE_BOUNDS } from "@/api/lib/dates";

/** The `case_law_decisions` CHECK that holds `decisionDateWithinBoundsSql`. */
export const CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT =
  "case_law_decisions_decision_date_bounds";

/** First day of a floor year. */
const floorSql = (year: number): SQL =>
  sql`make_date(${sql.raw(String(year))}, 1, 1)`;

/** First day past the ceiling, relative to the current UTC day. */
const ceilingSql = sql`((now() AT TIME ZONE 'UTC')::date
         + ${sql.raw(String(DECISION_DATE_BOUNDS.daysAhead + 1))})`;

const jurisdictionListSql = (
  jurisdictions: readonly CaseLawJurisdiction[],
): SQL => sql.raw(jurisdictions.map((code) => `'${code}'`).join(", "));

/**
 * Which countries a floor `year` applies to, and which it does not, as
 * predicates over `country`. The list names declared jurisdictions only, so a
 * country none declares falls on the default floor's side: in the complement
 * when the default floor reaches `year`, outside the list when it does not.
 */
const floorScopeSql = (
  country: SQLWrapper,
  year: number,
): { applies: SQL; exempt: SQL } => {
  const minYearOf = (jurisdiction: CaseLawJurisdiction) =>
    DECISION_DATE_BOUNDS.minYearByJurisdiction[jurisdiction];
  if (DECISION_DATE_BOUNDS.defaultMinYear >= year) {
    const lower = jurisdictionListSql(
      CASE_LAW_JURISDICTIONS.filter(
        (jurisdiction) => minYearOf(jurisdiction) < year,
      ),
    );
    return {
      applies: sql`${country} NOT IN (${lower})`,
      exempt: sql`${country} IN (${lower})`,
    };
  }
  const reaching = jurisdictionListSql(
    CASE_LAW_JURISDICTIONS.filter(
      (jurisdiction) => minYearOf(jurisdiction) >= year,
    ),
  );
  return {
    applies: sql`${country} IN (${reaching})`,
    exempt: sql`${country} NOT IN (${reaching})`,
  };
};

/**
 * The floor years in ascending order, each once: the lowest applies to every
 * row, each higher one only to the countries that carry it.
 */
const FLOOR_YEARS: readonly number[] = [
  ...new Set([
    DECISION_DATE_BOUNDS.defaultMinYear,
    ...Object.values(DECISION_DATE_BOUNDS.minYearByJurisdiction),
  ]),
].toSorted((left, right) => left - right);

/** True for a date the write-path guard would refuse; NULL for a NULL date. */
export const decisionDateOutOfBoundsSql = (
  column: SQLWrapper,
  country: SQLWrapper,
): SQL => {
  const [lowest, ...higher] = FLOOR_YEARS;
  const below = [
    sql`${column} < ${floorSql(lowest ?? DECISION_DATE_BOUNDS.defaultMinYear)}`,
    ...higher.map(
      (year) =>
        sql`(${column} < ${floorSql(year)} AND ${floorScopeSql(country, year).applies})`,
    ),
  ];
  return sql`(
  ${sql.join(
    below,
    sql`
  OR `,
  )}
  OR ${column} >= ${ceilingSql}
)`;
};

/**
 * True for a date the write-path guard accepts; NULL for a NULL date. The
 * negation of `decisionDateOutOfBoundsSql`, spelled out so a CHECK reads as
 * the range it enforces.
 */
export const decisionDateWithinBoundsSql = (
  column: SQLWrapper,
  country: SQLWrapper,
): SQL => {
  const [lowest, ...higher] = FLOOR_YEARS;
  const above = [
    sql`${column} >= ${floorSql(lowest ?? DECISION_DATE_BOUNDS.defaultMinYear)}`,
    ...higher.map(
      (year) =>
        sql`(${column} >= ${floorSql(year)} OR ${floorScopeSql(country, year).exempt})`,
    ),
  ];
  return sql`(
  ${sql.join(
    above,
    sql`
  AND `,
  )}
  AND ${column} < ${ceilingSql}
)`;
};
