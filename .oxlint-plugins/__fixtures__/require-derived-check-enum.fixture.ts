// Passive regression fixture for
// `require-derived-check-enum/require-derived-check-enum`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the lowercase
// spelling or the nested-template walk), the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.

import { sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";

const STATUSES = ["active", "archived"] as const;
const column = sql`status`;

// The plain form: every element quoted, list closed in the same chunk.
// oxlint-disable-next-line require-derived-check-enum/require-derived-check-enum
const _uppercase = p.check("t_status_check", sql`${column} IN ('a', 'b')`);

// Lowercase `in` is equally valid SQL and equally hand-written.
// oxlint-disable-next-line require-derived-check-enum/require-derived-check-enum
const _lowercase = p.check("t_status_check", sql`${column} in ('a', 'b')`);

// Bare `check(...)` without the namespace reaches the same constraint.
// oxlint-disable-next-line require-derived-check-enum/require-derived-check-enum
const _bareCallee = check("t_status_check", sql`${column} IN ('a', 'b')`);

// Tight spacing renders a different string but mirrors a const just the same.
// oxlint-disable-next-line require-derived-check-enum/require-derived-check-enum
const _tight = check("t_status_check", sql`${column} IN ('a','b')`);

// A single-value list is the same mirror when the const has one member.
// oxlint-disable-next-line require-derived-check-enum/require-derived-check-enum
const _singleValue = check("t_kind_check", sql`kind IN ('task')`);

// The list may sit anywhere in a larger predicate, including a nested
// template the walk has to reach.
const _nested = check(
  "t_status_check",
  // oxlint-disable-next-line require-derived-check-enum/require-derived-check-enum
  sql`${column} IS NULL OR ${sql`${column} IN ('a', 'b')`}`,
);

// The derived form: the values come from the const, so the constraint cannot
// drift from the column.
const _derived = check(
  "t_status_check",
  sql`${column} IN (${sql.join(
    STATUSES.map((status) => sql.raw(`'${status}'`)),
    sql`, `,
  )})`,
);

// A list that already interpolates is not a mirror of one const; the rule
// cannot tell which part should derive from what, so it stays quiet.
const _partiallyInterpolated = check(
  "t_status_check",
  sql`${column} IN ('a', ${sql.raw("'b'")})`,
);

// A commented-out list is not SQL Postgres evaluates.
const _commented = check(
  "t_status_check",
  sql`${column} IS NOT NULL -- was: IN ('a', 'b')`,
);

// Outside a `check(...)` call the same text is a query predicate, not a
// constraint mirroring a column's enum.
const _predicate = sql`${column} IN ('a', 'b')`;

export {
  _bareCallee,
  _commented,
  _derived,
  _lowercase,
  _nested,
  _partiallyInterpolated,
  _predicate,
  _singleValue,
  _tight,
  _uppercase,
};
