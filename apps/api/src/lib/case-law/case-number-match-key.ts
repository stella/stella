// parser-output-unchanged: Match keys are read by comparisons only; no adapter or parser writes them, and every stored key keeps its printed form.
/**
 * The case-number match key, rendered as SQL.
 *
 * A docket key is stored as its publisher printed it, and publishers print
 * one case with its year in four digits or in two ("c-679/2018" and
 * "c-679/18"). Two keys name the same case when their match keys are equal.
 * The function itself is `caseNumberMatchKey` in
 * `@stll/api-contract/case-number-match-key`; this module renders the same
 * function as SQL, from the same pattern, for the expression indexes on the
 * key columns and the comparisons that read them.
 * `case-number-match-key.db.test.ts` holds the two renderings to one answer.
 *
 * The rendering is a literal, never a bind parameter: the planner uses an
 * expression index only for a query that spells the indexed expression
 * exactly, and `regexp_replace` over constants is IMMUTABLE, so the same
 * text is an index expression too.
 */
import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  CASE_NUMBER_FULL_YEAR_TAIL_PATTERN,
  caseNumberMatchKey,
} from "@stll/api-contract/case-number-match-key";

export { caseNumberMatchKey };

// The pattern is a constant holding no quote, so it is spelled as a literal.
const PATTERN_LITERAL = sql.raw(`'${CASE_NUMBER_FULL_YEAR_TAIL_PATTERN}'`);
// The two groups in PostgreSQL's back-reference spelling; `$1$2` in
// ECMAScript. Under standard_conforming_strings a backslash in a literal is
// itself.
const REPLACEMENT_LITERAL = sql.raw(String.raw`'/\1\2'`);

/** A key expression's match key, as the expression indexes are built on. */
export const caseNumberMatchKeySql = (key: SQLWrapper): SQL =>
  sql`regexp_replace(${key}, ${PATTERN_LITERAL}, ${REPLACEMENT_LITERAL})`;

/**
 * The match key of a column as DDL spells it (`"citation_key"`), for an online
 * index's `createSql`. Rendered from `caseNumberMatchKeySql`, so the index and
 * the queries it serves cannot spell the expression differently.
 */
export const caseNumberMatchKeyDdl = (column: string): string =>
  new PgDialect().sqlToQuery(caseNumberMatchKeySql(sql.raw(column))).sql;
