import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  decisionHasLegalSentenceSql,
  decisionSearchCategorySql,
} from "@/api/lib/case-law/decision-search-metadata-sql";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: PGlite;
const dialect = new PgDialect();
beforeAll(async () => {
  client = await createTestPglite();
}, 120_000);
afterAll(async () => {
  await client.close();
});

test("legal sentence presence distinguishes text from absent and non-text metadata", async () => {
  const metadata = [
    {},
    { legalSentence: null },
    { legalSentence: "" },
    { legalSentence: "   " },
    { legalSentence: [] },
    { legalSentence: {} },
    { legalSentence: "Právní věta." },
  ];
  const compiled = dialect.sqlToQuery(sql`
    SELECT ${decisionHasLegalSentenceSql(sql`metadata`)} AS present
    FROM jsonb_array_elements(${JSON.stringify(metadata)}::text::jsonb) AS samples(metadata)
  `);
  const result = await client.query<{ present: boolean }>(
    compiled.sql,
    compiled.params,
  );
  expect(result.rows.map(({ present }) => present)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
});

test("categories preserve exact bounded strings and exclude structured metadata", async () => {
  const metadata = [
    {},
    { category: null },
    { category: "A" },
    { category: "a" },
    { category: ["A"] },
    { category: { label: "A" } },
    { category: "A".repeat(129) },
  ];
  const compiled = dialect.sqlToQuery(sql`
    SELECT ${decisionSearchCategorySql(sql`metadata`)} AS category
    FROM jsonb_array_elements(${JSON.stringify(metadata)}::text::jsonb) AS samples(metadata)
  `);
  const result = await client.query<{ category: string | null }>(
    compiled.sql,
    compiled.params,
  );
  expect(result.rows.map(({ category }) => category)).toEqual([
    null,
    null,
    "A",
    "a",
    null,
    null,
    null,
  ]);
});

test("metadata filter expressions have index conditions under country scope", async () => {
  await client.exec("SET enable_seqscan = off");
  for (const predicate of [
    sql`${decisionSearchCategorySql(sql`metadata`)} = 'A'`,
    sql`${decisionHasLegalSentenceSql(sql`metadata`)} = true`,
    sql`${decisionHasLegalSentenceSql(sql`metadata`)} = false`,
  ]) {
    const compiled = dialect.sqlToQuery(sql`
      EXPLAIN (FORMAT JSON) SELECT id FROM case_law_decisions
      WHERE country = 'CZE' AND ${predicate}
    `);
    const result = await client.query(compiled.sql, compiled.params);
    const plan = JSON.stringify(result.rows);
    expect(plan).toContain("Index Cond");
    expect(plan).toMatch(/country_(?:category|legal_sentence)_idx/u);
  }
  await client.exec("RESET enable_seqscan");
});
