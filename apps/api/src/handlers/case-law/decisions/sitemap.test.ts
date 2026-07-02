import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api-postgres";
import { asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  decisionBucketSql,
  decisionMonthSql,
  decisionYearSql,
} from "@/api/handlers/case-law/decisions/sitemap";
import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
} from "@/api/tests/pglite-schema";

// Regression: the sitemap-shard queries render the year/month/bucket fragments
// into both the SELECT list and the GROUP BY (and ORDER BY). Each drizzle `sql`
// bind parameter gets a fresh placeholder number per render ($1 in SELECT, $3 in
// GROUP BY), so if a fragment binds its constant (the COALESCE undated fallback,
// the bucket modulus/width), the SELECT and GROUP BY renderings differ and
// Postgres rejects the grouped SELECT ("column ... must appear in the GROUP BY
// clause"). PGlite is real Postgres, so executing the grouped queries below
// fails loudly if that mismatch ever returns.

const allSchema = { ...schema, ...authSchema, ...rlsExports };

let client: Awaited<ReturnType<typeof createSchemaPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();

beforeAll(async () => {
  client = await createSchemaPglite();
  db = drizzle({ client });
  await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
  await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
  await installPgliteSchemaPrerequisites(db);
  const { sqlStatements } = await pushSchema(allSchema, db);
  for (const statement of sqlStatements) {
    // oxlint-disable-next-line no-await-in-loop -- DDL statements must apply in emitted order (deterministic test schema setup)
    await db.execute(sql.raw(statement));
  }

  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "test",
    name: "Test source",
  });

  await db.insert(caseLawDecisions).values([
    {
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: "1 Cdo 1/2020",
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2020-03-15",
    },
    {
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: "2 Cdo 2/2020",
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2020-05-20",
    },
    {
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: "3 Cdo 3/2021",
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2021-01-10",
    },
    {
      // A dateless decision exercises the COALESCE undated-year/month fallback,
      // the literal that previously got bound as a parameter.
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: "4 Cdo 4/undated",
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      decisionDate: null,
    },
  ]);
}, 120_000);

afterAll(async () => {
  await client.close();
});

test("natural-shard query groups by year/month without a GROUP BY mismatch", async () => {
  const rows = await db
    .select({
      country: caseLawDecisions.country,
      year: decisionYearSql,
      month: decisionMonthSql,
      total: sql<number>`count(*)::int`,
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(redistributableCaseLawSource)
    .groupBy(caseLawDecisions.country, decisionYearSql, decisionMonthSql)
    .orderBy(
      asc(caseLawDecisions.country),
      desc(decisionYearSql),
      desc(decisionMonthSql),
    );

  // One shard per (country, year, month): three dated months plus the undated
  // bucket.
  expect(rows).toHaveLength(4);
  expect(rows.every((row) => row.country === "CZE")).toBe(true);
  expect(rows.every((row) => row.total === 1)).toBe(true);

  const shardKeys = rows.map((row) => `${row.year}-${row.month}`);
  expect(shardKeys).toContain("2020-03");
  expect(shardKeys).toContain("2020-05");
  expect(shardKeys).toContain("2021-01");
  expect(shardKeys).toContain("undated-00");
});

test("bucket-shard query groups by the hashed bucket without a GROUP BY mismatch", async () => {
  const rows = await db
    .select({
      country: caseLawDecisions.country,
      year: decisionYearSql,
      month: decisionMonthSql,
      bucket: decisionBucketSql,
      total: sql<number>`count(*)::int`,
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(redistributableCaseLawSource)
    .groupBy(
      caseLawDecisions.country,
      decisionYearSql,
      decisionMonthSql,
      decisionBucketSql,
    )
    .orderBy(
      asc(caseLawDecisions.country),
      desc(decisionYearSql),
      desc(decisionMonthSql),
      asc(decisionBucketSql),
    );

  // Each seeded decision hashes into its own (shard, bucket) group here, so the
  // read succeeds and returns one row per decision.
  expect(rows).toHaveLength(4);
  expect(rows.every((row) => row.total === 1)).toBe(true);
  // The bucket is a zero-padded two-character token from the fragment's lpad.
  expect(rows.every((row) => /^[0-9]{2}$/u.test(row.bucket))).toBe(true);
});
