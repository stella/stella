import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getViewConfig, PgDialect } from "drizzle-orm/pg-core";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { listDecisionsPageQuery } from "@/api/handlers/case-law/decisions/list";
import { readCourtNames } from "@/api/handlers/case-law/decisions/shelf-courts";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { CASE_LAW_COURT_DATE_PUBLISHED_INDEX } from "@/api/lib/case-law/court-date-index";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const PUBLISHED_INDEX = CASE_LAW_COURT_DATE_PUBLISHED_INDEX.name;
const COURTS = 20;
const PAGE_SIZE = 10;

const indexScans = (
  node: Record<string, unknown>,
): Record<string, unknown>[] => {
  const scans = node["Index Name"] === PUBLISHED_INDEX ? [node] : [];
  const children = node["Plans"];
  if (children === undefined) {
    return scans;
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("Court plan has malformed children");
  }
  return scans.concat(children.flatMap(indexScans));
};

describe.skipIf(!enabled)("published court walks (postgres)", () => {
  // timeout: isolated schema setup, two corpus sizes and VACUUM need an integration budget.
  test("vocabulary and browse seek published index ranges at both corpus sizes", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL is required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const captured: { query: string; params: unknown[] }[] = [];
      const { db, sql: client } = openClient({
        max: 1,
        logger: {
          logQuery: (query, params) => {
            captured.push({ query, params });
          },
        },
      });
      const schemaName = `court_plan_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        for (const table of ["case_law_sources", "case_law_decisions"]) {
          await db.execute(sql`CREATE TABLE ${schema}.${sql.identifier(table)}
            (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        }
        await db.execute(sql`SET search_path TO ${schema}, public`);
        const view = getViewConfig(publishedCaseLawDecisions);
        await db.execute(sql`CREATE VIEW ${schema}.${sql.identifier(view.name)}
          AS (${sql.raw(new PgDialect().sqlToQuery(view.query).sql)})`);
        // Remove any cloned published twin, so the guard exercises the online
        // declaration even when the template already has this index installed.
        const clones = await db.execute(sql`SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schemaName} AND tablename = 'case_law_decisions'
            AND indexdef LIKE '%(country, court, COALESCE(decision_date%'
            AND indexdef LIKE '% WHERE %'`);
        for (const row of clones) {
          const name = row["indexname"];
          if (typeof name !== "string") {
            panic("Cloned index has no name");
          }
          await db.execute(sql`DROP INDEX ${schema}.${sql.identifier(name)}`);
        }
        const index = CASE_LAW_COURT_DATE_PUBLISHED_INDEX;
        await db.execute(
          sql.raw(
            index.createSql
              .replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX")
              .replace(
                'public."case_law_decisions"',
                () => `"${schemaName}"."case_law_decisions"`,
              ),
          ),
        );
        const installed =
          await db.execute(sql`SELECT pg_get_indexdef(indexrelid) AS definition
          FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid
          JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
          WHERE pg_namespace.nspname = ${schemaName} AND pg_class.relname = ${PUBLISHED_INDEX}`);
        expect(installed).toEqual([
          {
            definition: `CREATE INDEX ${PUBLISHED_INDEX} ${index.definitionBody.replace("ON public.", () => `ON ${schemaName}.`)}`,
          },
        ]);
        const sourceId = createSafeId<"caseLawSource">();
        await db.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: "court-plan",
          name: "Court plan fixture",
        });
        const tx = asTestRaw<CaseLawPublicReadTransaction>(db);
        const caseLawDb = asTestRaw<CaseLawPublicReadDb>(
          async <T>(
            read: (transaction: CaseLawPublicReadTransaction) => Promise<T>,
          ) => await read(tx),
        );
        for (const decisions of [1000, 10_000]) {
          await db.execute(sql`TRUNCATE ${schema}.case_law_decisions`);
          // Hidden courts precede the published names and make a heap-filtered
          // loose scan inspect excluded rows before reaching its first court.
          await db.execute(sql`INSERT INTO case_law_decisions
            (id, source_id, case_number, court, country, language, decision_date, redacted_at, metadata)
            SELECT gen_random_uuid(), ${sourceId}::uuid, status || '/' || n,
              CASE WHEN status = 'published' THEN 'Court ' || lpad((n % ${COURTS})::text, 2, '0')
                ELSE 'Excluded ' || status END,
              'CZE', 'cs', CASE WHEN n % 7 = 0 THEN NULL ELSE DATE '2020-01-01' + (n % 365) END,
              CASE WHEN status = 'redacted' THEN TIMESTAMPTZ '2026-01-01 00:00:00+00' END,
              CASE WHEN status = 'listing-only' THEN
                '{"_stellaPartialObservation":{"isListingOnly":true}}'::jsonb ELSE '{}'::jsonb END
            FROM generate_series(1, ${decisions}::int) n
            CROSS JOIN (VALUES ('published'), ('redacted'), ('listing-only')) statuses(status)`);
          await db.execute(sql`VACUUM (ANALYZE) case_law_decisions`);
          await db.execute(sql`ANALYZE case_law_sources`);
          captured.length = 0;
          expect(await readCourtNames({ caseLawDb, country: "CZE" })).toEqual(
            Array.from(
              { length: COURTS },
              (_, n) => `Court ${String(n).padStart(2, "0")}`,
            ),
          );
          const vocabulary =
            captured.at(0) ?? panic("Vocabulary SQL was not captured");
          expect(captured).toHaveLength(1);
          const vocabularyPlan = explainRoot(
            await client.unsafe(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${vocabulary.query}`,
              vocabulary.params,
            ),
          );
          const vocabularyScans = scanOccurrences(vocabularyPlan).filter(
            ({ relation }) => relation === "case_law_decisions",
          );
          expect(vocabularyScans).toHaveLength(2);
          for (const scan of vocabularyScans) {
            expect(scan.index).toBe(PUBLISHED_INDEX);
            expect(scan.nodeType).toBe("Index Only Scan");
            expect(scan.filter).toBeNull();
          }
          for (const scan of indexScans(vocabularyPlan)) {
            expect(scan["Actual Rows"]).toBeLessThanOrEqual(1);
            expect(scan["Actual Loops"]).toBeLessThanOrEqual(COURTS + 1);
            expect(scan["Heap Fetches"]).toBe(0);
          }
          expect(JSON.stringify(vocabularyPlan)).not.toMatch(
            /redacted_at|isListingOnly/u,
          );
          captured.length = 0;
          const rows = await listDecisionsPageQuery({
            tx,
            query: { country: "CZE", court: "Court 00" },
            limit: PAGE_SIZE,
            cursor: undefined,
          });
          expect(rows).toHaveLength(PAGE_SIZE + 1);
          const browse = captured.at(0) ?? panic("Browse SQL was not captured");
          expect(captured).toHaveLength(1);
          const browsePlan = explainRoot(
            await client.unsafe(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${browse.query}`,
              browse.params,
            ),
          );
          const browseScans = scanOccurrences(browsePlan).filter(
            ({ index: name }) => name === PUBLISHED_INDEX,
          );
          expect(browseScans).toHaveLength(1);
          for (const scan of browseScans) {
            expect(scan.indexCond).toContain("country");
            expect(scan.indexCond).toContain("court");

            expect(scan.filter ?? "").not.toMatch(/redacted_at|isListingOnly/u);
          }
          for (const scan of indexScans(browsePlan)) {
            expect(scan["Actual Rows"]).toBe(PAGE_SIZE + 1);
            expect(scan["Actual Loops"]).toBe(1);
          }
          // Removing the twin must expose the old publication heap filter.
          // This is the same vocabulary SQL, over the same representative data.
          await db.execute(
            sql`DROP INDEX ${schema}.${sql.identifier(PUBLISHED_INDEX)}`,
          );
          const withoutTwin = explainRoot(
            await client.unsafe(
              `EXPLAIN (COSTS OFF, FORMAT JSON) ${vocabulary.query}`,
              vocabulary.params,
            ),
          );
          expect(JSON.stringify(withoutTwin)).toMatch(
            /redacted_at|isListingOnly/u,
          );
          await db.execute(
            sql.raw(
              index.createSql
                .replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX")
                .replace(
                  'public."case_law_decisions"',
                  () => `"${schemaName}"."case_law_decisions"`,
                ),
            ),
          );
        }
      } finally {
        await db.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 120_000);
});
