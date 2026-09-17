import { expect, test } from "bun:test";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { caseLawDecisions } from "@/api/db/schema";
import {
  CASE_LAW_SEARCH_CANDIDATE_ROW_BOUND_CONSTRAINT,
  searchCandidateRowWithinBoundsSql,
} from "@/api/lib/case-law/search-candidate-row-bound-sql";
import { storedObservationHasDetail } from "@/api/lib/legal-search/partial-observation-sql";

const INDEX_NAME = "case_law_decisions_search_candidate_idx";
const MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260917120000_case_law_decisions_search_candidate_idx/migration.sql",
);
const KEY_COLUMNS = [
  "id",
  "country",
  "source_id",
  "court",
  "decision_date",
  "decision_type",
  "language",
  "citation_authority",
  "language_group_key",
];

const searchCandidateIndex = () =>
  getTableConfig(caseLawDecisions).indexes.find(
    (candidate) => candidate.config.name === INDEX_NAME,
  );

const migrationStatement = (pattern: RegExp): string | undefined =>
  pattern
    .exec(readFileSync(MIGRATION, "utf-8"))
    ?.at(0)
    ?.replaceAll(/\s+/gu, " ")
    .trim();

const createStatement = (): string | undefined =>
  migrationStatement(/^CREATE INDEX CONCURRENTLY[^;]+;/mu);

const unqualified = (statement: string): string =>
  statement.replaceAll(`"case_law_decisions".`, "").replaceAll(/\s+/gu, " ");

test("the search candidate index carries the same columns in schema and migration", () => {
  expect(
    searchCandidateIndex()?.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    ),
  ).toEqual(KEY_COLUMNS);

  const columns = KEY_COLUMNS.map((column) => `"${column}"`).join(", ");
  expect(createStatement()).toContain(
    `CREATE INDEX CONCURRENTLY "${INDEX_NAME}" ON "case_law_decisions" (${columns})`,
  );
});

/**
 * The index is only usable while its predicate is the same text the reads
 * apply, and only while that text holds no parameter: PostgreSQL proves the
 * implication against constants, and a generic plan leaves a bound path a
 * parameter. Either drift loses the index silently, which is the cold latency
 * it was built to remove.
 */
test("the search candidate index is predicated on the reads' own publication gate", () => {
  const predicate = new PgDialect().sqlToQuery(
    storedObservationHasDetail(caseLawDecisions.metadata),
  );
  expect(predicate.params).toEqual([]);

  const indexPredicate = searchCandidateIndex()?.config.where;
  expect(indexPredicate && new PgDialect().sqlToQuery(indexPredicate).sql).toBe(
    predicate.sql,
  );

  expect(createStatement()).toContain(
    `WHERE ${predicate.sql.replaceAll(`"case_law_decisions".`, "")}`,
  );
});

/**
 * A B-tree tuple is bounded in bytes while `varchar(n)` bounds characters, so
 * the three variable-width columns the index carries need a byte budget of
 * their own. Schema and migration state the same one, from the same builder.
 */
test("the search candidate index's columns are bounded by one budget", () => {
  const bound = new PgDialect().sqlToQuery(
    searchCandidateRowWithinBoundsSql({
      court: caseLawDecisions.court,
      decisionType: caseLawDecisions.decisionType,
      languageGroupKey: caseLawDecisions.languageGroupKey,
    }),
  );
  expect(bound.params).toEqual([]);

  const check = getTableConfig(caseLawDecisions).checks.find(
    (candidate) =>
      candidate.name === CASE_LAW_SEARCH_CANDIDATE_ROW_BOUND_CONSTRAINT,
  );
  expect(check && new PgDialect().sqlToQuery(check.value).sql).toBe(bound.sql);

  expect(
    migrationStatement(
      /^ALTER TABLE "case_law_decisions"\s+ADD CONSTRAINT[^;]+;/mu,
    ),
  ).toBe(
    unqualified(
      `ALTER TABLE "case_law_decisions" ADD CONSTRAINT "${CASE_LAW_SEARCH_CANDIDATE_ROW_BOUND_CONSTRAINT}" CHECK ( ${bound.sql} ) NOT VALID;`,
    ),
  );
});
