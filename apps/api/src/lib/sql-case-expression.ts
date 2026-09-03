/**
 * One rule for rendering a SQL `CASE` over a list that can be empty.
 *
 * The registry-driven ranking expressions are generated from rows: court
 * weights, court tiers, citation polarities. A `CASE` needs at least one
 * `WHEN`, so a renderer that interpolates its branches straight into
 * `CASE ${branches} ELSE ${fallback} END` emits a syntax error the moment the
 * list it iterates is empty — an install whose registry table has not been
 * seeded yet fails every query that ranks, instead of ranking everything at
 * the default. Rendering through this helper makes the empty list produce the
 * fallback on its own, which is the value the `CASE` would have taken anyway.
 *
 * Two renderers, one rule: `sqlCaseExpression` for the interpolated SQL text
 * the ranking paths build, `sqlCaseFragment` for a Drizzle `SQL` composed from
 * per-row branches. `no-hand-rolled-sql-case` keeps every other module out of
 * the shape, so the emptiness decision cannot be made a second time.
 */

import { sql, type SQL } from "drizzle-orm";

/** The fallback for a CASE whose miss falls through to an enclosing COALESCE. */
export const SQL_NULL = "NULL";

type SqlCaseExpressionOptions = {
  /**
   * `WHEN … THEN …` branches, in the order they must be evaluated: Postgres
   * takes the first true branch, so the caller's precedence order is the
   * ranking, and this helper preserves it as given.
   */
  branches: readonly string[];
  /**
   * The `ELSE` value, and the whole expression when there are no branches.
   * Pass `SQL_NULL` for a `CASE` whose miss is meant to fall through to an
   * enclosing `COALESCE`.
   */
  fallback: string | number;
};

export const sqlCaseExpression = ({
  branches,
  fallback,
}: SqlCaseExpressionOptions): string =>
  branches.length === 0
    ? String(fallback)
    : `CASE ${branches.join("\n      ")}\n      ELSE ${fallback} END`;

type SqlCaseFragmentOptions = {
  /** `WHEN … THEN …` fragments, in the order Postgres must evaluate them. */
  branches: readonly SQL[];
  /** The `ELSE` value, and the whole fragment when there are no branches. */
  fallback: SQL;
  /**
   * The simple-`CASE` operand each branch's `WHEN` value is compared against
   * (`CASE id WHEN … END`). Omit for a searched `CASE` whose branches carry
   * their own predicates.
   */
  operand?: SQL;
};

/**
 * `sqlCaseExpression` for callers composing a Drizzle `SQL` rather than text.
 *
 * The empty list returns the fallback fragment itself, so a per-row `CASE`
 * built from a batch that turned out to hold no rows updates a column to the
 * value it already has instead of rendering `CASE id ELSE col END`, which
 * Postgres rejects for the same reason a branchless text `CASE` is rejected.
 */
export const sqlCaseFragment = ({
  branches,
  fallback,
  operand,
}: SqlCaseFragmentOptions): SQL => {
  if (branches.length === 0) {
    return fallback;
  }
  const subject = operand === undefined ? sql`` : sql` ${operand}`;
  // Copied because `sql.join` takes a mutable chunk list, and the caller's
  // branch list is readonly.
  return sql`CASE${subject} ${sql.join([...branches], sql.raw(" "))} ELSE ${fallback} END`;
};
