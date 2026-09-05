import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";

import {
  caseLawCorpusIndexBackfills,
  caseLawCorpusIndexProjections,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CASE_LAW_INDEX_GROUP_OF,
  caseLawIndexIdSql,
} from "@/api/lib/legal-search/case-law-index-groups";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { isRecord } from "@/api/lib/type-guards";
import {
  INDEX_ID_FUNCTION,
  installCaseLawProjectionTrigger,
  latestMigrationContaining,
} from "@/api/tests/helpers/case-law-projection-trigger";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The physical index id is derived in three runtimes: `corpusIndexId` in
 * TypeScript, `caseLawIndexIdSql` in the queries, and
 * `case_law_corpus_index_id` in the projection trigger. Each is proved equal
 * to the others here against a real PostgreSQL, over every declared
 * jurisdiction in both letter cases, countries outside the declaration, and
 * generations on both sides of the grouping threshold, at and past the
 * integer bound, plus one from another family.
 */

const DECLARED: readonly string[] = Object.keys(CASE_LAW_INDEX_GROUP_OF);
const COUNTRIES: readonly string[] = [
  ...DECLARED,
  ...DECLARED.map((country) => country.toLowerCase()),
  // A code that spells a language tag derives an index of its own.
  "PL",
  "HUN",
  "ROU",
  "xyz",
];
const GENERATIONS: readonly string[] = [
  "case_law_v1",
  "case_law_v2",
  "case_law_v3",
  "case_law_v12",
  // The last order the checkpoint column holds, and the first past it: the
  // former is grouped, the latter is not a case-law generation and stays per
  // country rather than failing an integer cast.
  "case_law_v2147483647",
  "case_law_v2147483648",
  "legislation_v1",
];

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

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
    await installCaseLawProjectionTrigger(db);
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
  expect(corpusIndexId("case_law_v2147483647", "CZE")).toBe(
    "case_law_v2147483647_cs_sk",
  );
  expect(corpusIndexId("case_law_v2147483648", "CZE")).toBe(
    "case_law_v2147483648_cze",
  );
  expect(corpusIndexId("case_law_v3", "PL")).not.toBe(
    corpusIndexId("case_law_v3", "POL"),
  );
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
