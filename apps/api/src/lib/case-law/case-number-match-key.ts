// parser-output-unchanged: Match keys are read by comparisons only; no adapter or parser writes them, and every stored key keeps its printed form.
// parser-output-unchanged: adds only SQL comparison fragments and re-exports caseNumberKeysMatch; caseNumberMatchKey is unchanged and no adapter or parser calls the additions.
/**
 * The one place a case-number key is compared to another.
 *
 * A docket key is stored as its publisher printed it, and publishers print
 * one case with its year in four digits or in two ("c-679/2018" and
 * "c-679/18"). Every comparison of a key on one side with a key on the other
 * (a citation's key with a holder's, a lookup's keys with the stored ones, an
 * arriving identifier with the citations it can answer) compares their match
 * keys, through the fragments below. The function itself is
 * `caseNumberMatchKey` in `@stll/api-contract/case-number-match-key`; this
 * module renders the same function as SQL, from the same pattern, for the
 * queries and for the expression indexes that serve them.
 * `case-number-match-key.db.test.ts` holds the two renderings to one answer.
 *
 * The rendering is a literal, never a bind parameter: the planner uses an
 * expression index only for a query that spells the indexed expression
 * exactly, and `regexp_replace` over constants is IMMUTABLE, so the same
 * text is an index expression too.
 *
 * `no-raw-case-number-key-equality` keeps every other module from comparing
 * the key columns directly.
 */
import type { Column, SQL, SQLWrapper } from "drizzle-orm";
import { inArray, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  CASE_NUMBER_FULL_YEAR_TAIL_PATTERN,
  caseNumberKeysMatch,
  caseNumberMatchKey,
} from "@stll/api-contract/case-number-match-key";

export { caseNumberKeysMatch, caseNumberMatchKey };

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

/**
 * Two key expressions name the same case. Plain equality: NULL on either
 * side matches nothing, as the raw comparison it replaces did.
 */
export const caseNumberKeysMatchSql = (
  left: SQLWrapper,
  right: SQLWrapper,
): SQL => sql`${caseNumberMatchKeySql(left)} = ${caseNumberMatchKeySql(right)}`;

/**
 * Two key expressions hold the same stored bytes: a row's key against its own
 * rewrite, or against the copy a review row keeps of it. Never two printings
 * of a case, which `caseNumberKeysMatchSql` compares; spelled here so every
 * key comparison says which of the two it means.
 */
export const sameStoredCaseNumberKeySql = (
  left: SQLWrapper,
  right: SQLWrapper,
): SQL => sql`${left} = ${right}`;

/**
 * A key expression names one of the given keys. The keys are folded here and
 * bound, so the probe is the indexed expression against constants.
 */
export const caseNumberKeyAmongSql = (
  key: SQLWrapper,
  keys: readonly [string, ...string[]],
): SQL => {
  const [only, ...rest] = [...new Set(keys.map(caseNumberMatchKey))];
  return rest.length === 0 && only !== undefined
    ? sql`${caseNumberMatchKeySql(key)} = ${only}`
    : sql`${caseNumberMatchKeySql(key)} = ANY (ARRAY[${sql.join(
        [only, ...rest].map((folded) => sql`${folded}`),
        sql`, `,
      )}]::text[])`;
};

/**
 * Two ECLI identifier keys name the same decision. An ECLI carries no
 * slash-year tail, so its stored key is its identity, compared byte for byte
 * as the plain index on the identifier keys serves it.
 */
export const ecliKeysMatchSql = (left: Column, right: Column): SQL =>
  sql`${left} = ${right}`;

/** An ECLI identifier key is one of the given ECLI keys, byte for byte. */
export const ecliKeyAmongSql = (key: Column, keys: readonly string[]): SQL =>
  inArray(key, [...keys]);
