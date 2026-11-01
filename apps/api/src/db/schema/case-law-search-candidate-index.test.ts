import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { isNotNull } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { caseLawDecisions } from "@/api/db/schema";
import {
  publishedCaseLawDecisionFor,
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";
import {
  CASE_LAW_SEARCH_CANDIDATE_ROW_BOUND_CONSTRAINT,
  searchCandidateRowWithinBoundsSql,
} from "@/api/lib/case-law/search-candidate-row-bound-sql";
import { installPgliteDecisionDocketFilingYear } from "@/api/tests/pglite-schema";

import type { OnlineIndexDeclaration } from "../online-ddl";
import { ONLINE_MIGRATION_INDEXES } from "../online-migrations";

const onlineMigrationIndexes: readonly OnlineIndexDeclaration[] =
  ONLINE_MIGRATION_INDEXES;

const INDEX_NAME = "case_law_decisions_search_candidate_published_idx";
const BYTE_BOUND_MIGRATION = nodePath.resolve(
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

const byteBoundMigrationStatement = (pattern: RegExp): string | undefined =>
  pattern
    .exec(readFileSync(BYTE_BOUND_MIGRATION, "utf-8"))
    ?.at(0)
    ?.replaceAll(/\s+/gu, " ")
    .trim();

const createStatement = (): string | undefined =>
  onlineMigrationIndexes.find((candidate) => candidate.name === INDEX_NAME)
    ?.createSql;

const unqualified = (statement: string): string =>
  statement.replaceAll(`"case_law_decisions".`, "").replaceAll(/\s+/gu, " ");

const publishedIndexNames = (): string[] => {
  const dialect = new PgDialect();
  const schemaIndexes = getTableConfig(caseLawDecisions).indexes;
  const queryPredicate = dialect.sqlToQuery(
    publishedCaseLawDecisionFor(caseLawDecisions),
  ).sql;
  const indexPredicate = publishedCaseLawDecisionIndexPredicateSql();
  const schemaNames = schemaIndexes
    .filter(
      (candidate) =>
        candidate.config.where !== undefined &&
        dialect.sqlToQuery(candidate.config.where).sql.includes(queryPredicate),
    )
    .map(
      (candidate) =>
        candidate.config.name ?? panic("A publication index has no name"),
    )
    .toSorted();
  const onlineNames = onlineMigrationIndexes
    .filter(
      (candidate) =>
        candidate.tableName === "case_law_decisions" &&
        candidate.createSql?.includes(indexPredicate) === true,
    )
    .map((candidate) => candidate.name)
    .toSorted();

  expect(onlineNames).toEqual(schemaNames);
  return schemaNames;
};

test("the search candidate index carries the same columns in schema and online migration", () => {
  expect(
    searchCandidateIndex()?.config.columns.map((column) => {
      if (!("name" in column) || typeof column.name !== "string") {
        return panic("The search candidate index contains an unnamed column");
      }
      return column.name;
    }),
  ).toEqual(KEY_COLUMNS);

  const columns = KEY_COLUMNS.map((column) => `"${column}"`).join(", ");
  expect(createStatement()).toContain(
    `CREATE INDEX CONCURRENTLY "${INDEX_NAME}" ON public."case_law_decisions" USING btree (${columns})`,
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
    publishedCaseLawDecisionFor(caseLawDecisions),
  );
  expect(predicate.params).toEqual([]);

  const indexPredicate = searchCandidateIndex()?.config.where;
  expect(indexPredicate && new PgDialect().sqlToQuery(indexPredicate).sql).toBe(
    predicate.sql,
  );

  expect(createStatement()).toContain(
    `WHERE ${predicate.sql.replaceAll(`"case_law_decisions".`, "").replaceAll('"metadata"', "metadata").replaceAll('"redacted_at"', "redacted_at")}`,
  );
  expect(
    onlineMigrationIndexes.find((candidate) => candidate.name === INDEX_NAME)
      ?.definitionBody,
  ).toContain(`WHERE ${publishedCaseLawDecisionIndexDefinitionPredicateSql()}`);
});

test("public case-law index replacements all use the publication gate", () => {
  const schemaIndexes = getTableConfig(caseLawDecisions).indexes;
  const queryPredicate = new PgDialect().sqlToQuery(
    publishedCaseLawDecisionFor(caseLawDecisions),
  ).sql;
  const indexDefinitionPredicate =
    publishedCaseLawDecisionIndexDefinitionPredicateSql();
  const indexPredicate = publishedCaseLawDecisionIndexPredicateSql();

  for (const name of publishedIndexNames()) {
    const schemaIndex =
      schemaIndexes.find((candidate) => candidate.config.name === name) ??
      panic(`The case-law schema is missing ${name}`);
    const schemaPredicate =
      schemaIndex.config.where ??
      panic(`The case-law schema index ${name} has no predicate`);
    const onlineIndex =
      onlineMigrationIndexes.find((candidate) => candidate.name === name) ??
      panic(`The online migrations are missing ${name}`);
    expect(new PgDialect().sqlToQuery(schemaPredicate).sql).toContain(
      queryPredicate,
    );
    expect(onlineIndex.createSql).toContain(indexPredicate);
    // PostgreSQL flattens conjunctions when another gate follows publication.
    // The catalog test below checks the complete normalized expression.
    expect(onlineIndex.definitionBody).toContain(
      indexDefinitionPredicate.slice(1, -1),
    );
  }
});

test("the citation resolver keeps an all-row candidate index", () => {
  const name = "case_law_decisions_citation_candidate_idx";
  const schemaIndex =
    getTableConfig(caseLawDecisions).indexes.find(
      (candidate) => candidate.config.name === name,
    ) ?? panic(`The case-law schema is missing ${name}`);

  expect(
    schemaIndex.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    ),
  ).toEqual(["citation_key", "country", "decision_date", "id"]);
  const where = schemaIndex.config.where ?? panic(`${name} has no predicate`);
  expect(new PgDialect().sqlToQuery(where).sql).toBe(
    new PgDialect().sqlToQuery(isNotNull(caseLawDecisions.citationKey)).sql,
  );
});

test("public case-law online index definitions match PostgreSQL's catalog", async () => {
  await using database = new PGlite();
  const columns = getTableConfig(caseLawDecisions).columns;
  await database.exec(`
    CREATE TABLE case_law_decisions (
      ${columns.map((column) => `"${column.name}" ${column.getSQLType()}`).join(",\n")}
    );
  `);
  await installPgliteDecisionDocketFilingYear(drizzle({ client: database }));

  for (const name of publishedIndexNames()) {
    const index =
      onlineMigrationIndexes.find((candidate) => candidate.name === name) ??
      panic(`The online migrations are missing ${name}`);
    await database.exec(
      index.createSql?.replace(" CONCURRENTLY", "") ??
        panic(`The online migration for ${name} has no creation statement`),
    );
    const result = await database.query<{ definition: string }>(
      `SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid = '${name}'::regclass`,
    );
    expect(result.rows.at(0)?.definition).toBe(
      `CREATE INDEX ${name} ${index.definitionBody}`,
    );
  }
}, 15_000);

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
    byteBoundMigrationStatement(
      /^ALTER TABLE "case_law_decisions"\s+ADD CONSTRAINT[^;]+;/mu,
    ),
  ).toBe(
    unqualified(
      `ALTER TABLE "case_law_decisions" ADD CONSTRAINT "${CASE_LAW_SEARCH_CANDIDATE_ROW_BOUND_CONSTRAINT}" CHECK ( ${bound.sql} ) NOT VALID;`,
    ),
  );
});
