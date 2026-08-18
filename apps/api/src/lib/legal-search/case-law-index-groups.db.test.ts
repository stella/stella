import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  caseLawCorpusIndexBackfills,
  caseLawCorpusIndexProjections,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CASE_LAW_INDEX_GROUPS,
  caseLawIndexIdSql,
} from "@/api/lib/legal-search/case-law-index-groups";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The physical index id is derived in three runtimes: `corpusIndexId` in
 * TypeScript, `caseLawIndexIdSql` in the queries, and
 * `case_law_corpus_index_id` in the projection trigger. Each is proved equal
 * to the others here against a real PostgreSQL, over every group member in
 * both letter cases, countries outside every group, and generations on both
 * sides of the grouping threshold plus one from another family.
 */

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const INDEX_ID_FUNCTION =
  "CREATE OR REPLACE FUNCTION case_law_corpus_index_id(generation text, country text)";
const PROJECTION_TRIGGER_FUNCTION =
  "CREATE OR REPLACE FUNCTION enqueue_case_law_corpus_index_projection()";
const PROJECTION_TRIGGER =
  "CREATE TRIGGER case_law_decisions_enqueue_corpus_index_projection";

const COUNTRIES: readonly string[] = [
  ...Object.values(CASE_LAW_INDEX_GROUPS).flat(),
  ...Object.values(CASE_LAW_INDEX_GROUPS)
    .flat()
    .map((country) => country.toLowerCase()),
  "HUN",
  "ROU",
  "xyz",
];
const GENERATIONS: readonly string[] = [
  "case_law_v1",
  "case_law_v2",
  "case_law_v3",
  "case_law_v12",
  "legislation_v1",
];

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

/** Statements of a migration file, in order, comments included. */
const statementsOf = (path: string): string[] =>
  readFileSync(path, "utf-8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

/**
 * The last migration whose text contains `marker`. Migrations apply in
 * directory order, so that is the definition a database ends up with.
 */
const latestMigrationContaining = (marker: string): string => {
  const path = [...new Bun.Glob("*/migration.sql").scanSync(DRIZZLE_DIR)]
    .sort()
    .map((file) => nodePath.join(DRIZZLE_DIR, file))
    .findLast((file) => readFileSync(file, "utf-8").includes(marker));
  if (path === undefined) {
    throw new Error(`no migration contains ${marker}`);
  }
  return path;
};

/** Statements matching `statementMarker` from the last migration containing `marker`. */
const latestStatements = (
  marker: string,
  statementMarker: RegExp,
): string[] => {
  const statements = statementsOf(latestMigrationContaining(marker)).filter(
    (statement) => statementMarker.test(statement),
  );
  expect(statements.length).toBeGreaterThan(0);
  return statements;
};

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const readString = (row: unknown, key: string): string => {
  const value = isRecord(row) ? row[key] : undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${key} did not render as text`);
  }
  return value;
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    // The function under test, and the trigger that calls it, come from the
    // last migrations that define them, so the test runs the deployed text.
    const statements = [
      ...latestStatements(
        INDEX_ID_FUNCTION,
        /FUNCTION case_law_corpus_index_id\(/u,
      ),
      ...latestStatements(
        PROJECTION_TRIGGER_FUNCTION,
        /enqueue_case_law_corpus_index_projection\(\)\s+RETURNS trigger/u,
      ),
      // The replacement drop (`DROP TRIGGER IF EXISTS ...`) and the creation.
      ...latestStatements(
        PROJECTION_TRIGGER,
        /\b(?:CREATE|DROP) TRIGGER (?:IF EXISTS )?case_law_decisions_enqueue_corpus_index_projection\b/u,
      ),
    ];
    for (const statement of statements) {
      // oxlint-disable-next-line no-await-in-loop -- order-dependent DDL
      await db.execute(sql.raw(statement));
    }
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("the SQL function, the query fragment, and corpusIndexId derive the same id", async () => {
  const countryValues = sql.join(
    COUNTRIES.map((country) => sql`(${country}::varchar(3))`),
    sql`, `,
  );
  for (const generation of GENERATIONS) {
    // The generation is a bound parameter and the country a column, the
    // shapes the query layer feeds the fragment.
    // oxlint-disable-next-line no-await-in-loop -- one round trip per generation on a single test DB
    const result = await db.execute(sql`
      SELECT c.country AS "country",
             case_law_corpus_index_id(${generation}, c.country) AS "fn",
             (${caseLawIndexIdSql(sql`${generation}`, sql.raw("c.country"))}) AS "fragment"
        FROM (VALUES ${countryValues}) AS c(country)
    `);
    const rows = executedRows(result);
    expect(rows.length).toBe(COUNTRIES.length);
    for (const row of rows) {
      const country = readString(row, "country");
      const expected = corpusIndexId(generation, country);
      expect([generation, country, readString(row, "fn")]).toEqual([
        generation,
        country,
        expected,
      ]);
      expect([generation, country, readString(row, "fragment")]).toEqual([
        generation,
        country,
        expected,
      ]);
    }
  }
  // Non-vacuity: the grouped form differs from the per-country one where a
  // group holds several countries, and the ungrouped generations keep it.
  expect(corpusIndexId("case_law_v3", "CZE")).toBe("case_law_v3_cs_sk");
  expect(corpusIndexId("case_law_v3", "CZE")).not.toBe("case_law_v3_cze");
  expect(corpusIndexId("case_law_v2", "CZE")).toBe("case_law_v2_cze");
  expect(corpusIndexId("legislation_v1", "CZE")).toBe("legislation_v1_cze");
});

test("the migration's function body is the rendered query fragment", () => {
  const { sql: rendered, params } = new PgDialect().sqlToQuery(
    caseLawIndexIdSql(sql.raw("generation"), sql.raw("country")),
  );
  // DDL takes no bind parameters, so the fragment must carry none.
  expect(params).toEqual([]);

  const migration = readFileSync(
    latestMigrationContaining(INDEX_ID_FUNCTION),
    "utf-8",
  );
  const body =
    /RETURNS text\s+LANGUAGE sql\s+IMMUTABLE STRICT\s+AS \$function\$\s+SELECT (?<body>[\s\S]*?)\s+\$function\$;/u.exec(
      migration,
    )?.groups?.["body"];
  if (body === undefined) {
    throw new Error("migration does not define the function as expected");
  }
  const normalize = (text: string) => text.replaceAll(/\s+/gu, " ").trim();
  expect(normalize(body)).toBe(normalize(rendered));
});

test("the function is immutable and strict", async () => {
  const rows = executedRows(
    await db.execute(sql`
      SELECT provolatile::text AS "volatility", proisstrict AS "strict"
        FROM pg_proc
       WHERE proname = 'case_law_corpus_index_id'
    `),
  );
  expect(rows).toEqual([{ volatility: "i", strict: true }]);
  const nulls = executedRows(
    await db.execute(sql`
      SELECT case_law_corpus_index_id(NULL, 'CZE') AS "a",
             case_law_corpus_index_id('case_law_v3', NULL) AS "b"
    `),
  );
  expect(nulls).toEqual([{ a: null, b: null }]);
});

test("the projection trigger enqueues and accepts the grouped id", async () => {
  const generation = "case_law_v3";
  const sourceId = createSafeId<"caseLawSource">();
  const decisionId = createSafeId<"caseLawDecision">();
  const contentHash = "hash-1";
  await db
    .insert(caseLawSources)
    .values({ adapterKey: "public", id: sourceId, name: "public" });
  await db.insert(caseLawCorpusIndexBackfills).values({ generation });

  await db.insert(caseLawDecisions).values({
    caseNumber: "1 C 1/2024",
    contentHash,
    country: "CZE",
    court: "Test court",
    id: decisionId,
    language: "cs",
    sourceId,
  });
  const queued = await db
    .select({
      indexId: caseLawCorpusIndexProjections.indexId,
      pendingAction: caseLawCorpusIndexProjections.pendingAction,
      pendingIndexIds: caseLawCorpusIndexProjections.pendingIndexIds,
    })
    .from(caseLawCorpusIndexProjections);
  expect(queued).toEqual([
    {
      indexId: null,
      pendingAction: "index",
      pendingIndexIds: [corpusIndexId(generation, "CZE")],
    },
  ]);

  // The serving-generation mark is accepted only where it names the index
  // the generation derives for the row's country.
  await db
    .update(caseLawDecisions)
    .set({
      indexedGeneration: corpusIndexId(generation, "CZE"),
      indexedHash: contentHash,
    })
    .where(sql`${caseLawDecisions.id} = ${decisionId}`);
  const marked = await db
    .select({
      indexId: caseLawCorpusIndexProjections.indexId,
      indexedHash: caseLawCorpusIndexProjections.indexedHash,
    })
    .from(caseLawCorpusIndexProjections);
  expect(marked).toEqual([
    { indexId: "case_law_v3_cs_sk", indexedHash: contentHash },
  ]);
});
