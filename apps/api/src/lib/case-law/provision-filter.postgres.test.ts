import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { desc, sql } from "drizzle-orm";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { provisionDecisionPageQuery } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readCaseLawProvisionScope } from "@/api/lib/case-law/provision-filter";
import { CASE_LAW_PROVISION_SEARCH_INDEX } from "@/api/lib/case-law/provision-search-index";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawPublishedDecisionsFixtureSql } from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const PAGE_SIZE = 20;
const SCOPE_LIMIT = 128;
const GENERATION = "case_law_v5";
const PROVISION = {
  work: "2/1993 Sb.",
  anchor: "cl_36-odst_1",
  subsection: "1",
} as const;
const TABLES = [
  "case_law_sources",
  "case_law_decisions",
  "case_law_provision_citations",
  "corpus_index_jurisdiction_serving",
  "corpus_index_projection_states",
] as const;

const nodesOf = (root: Record<string, unknown>): Record<string, unknown>[] => {
  const children = root["Plans"];
  if (children === undefined) {
    return [root];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("The provision plan has malformed children");
  }
  return [root, ...children.flatMap(nodesOf)];
};

const readBlocks = (root: Record<string, unknown>) => {
  const hit = root["Shared Hit Blocks"];
  const read = root["Shared Read Blocks"];
  if (typeof hit !== "number" || typeof read !== "number") {
    return panic("The provision plan has no shared-buffer measurement");
  }
  return hit + read;
};

const citationScans = (root: Record<string, unknown>) => {
  const scans = nodesOf(root).filter(
    (node) => node["Relation Name"] === "case_law_provision_citations",
  );
  expect(scans.length).toBeGreaterThan(0);
  for (const scan of scans) {
    expect(["Index Scan", "Index Only Scan"]).toContain(
      String(scan["Node Type"]),
    );
    expect(String(scan["Index Name"])).toContain(
      "case_law_provision_citations",
    );
  }
  return scans;
};

describe.skipIf(!enabled)("widely cited provision search (postgres)", () => {
  // timeout: clone the real schema and seed two large, isolated synthetic corpora.
  test("scope and ranked pages stay bounded when one provision has ten times as many citing decisions", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL is required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const captured: { query: string; params: unknown[] }[] = [];
      const { db, sql: client } = openClient({
        max: 1,
        logger: {
          logQuery: (query, params) => captured.push({ query, params }),
        },
      });
      const schemaName = `provision_plan_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        for (const table of TABLES) {
          // db-await-in-loop: clone the fixed five-table fixture into an isolated schema.
          await db.execute(sql`CREATE TABLE ${schema}.${sql.identifier(table)}
            (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        }
        await db.execute(sql`SET search_path TO ${schema}, public`);
        await db.execute(caseLawPublishedDecisionsFixtureSql);
        const index = CASE_LAW_PROVISION_SEARCH_INDEX;
        const clones = await db.execute(sql`SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schemaName} AND tablename = 'case_law_decisions'
            AND indexdef LIKE '%(country, citation_authority DESC, id DESC)%'`);
        for (const row of clones) {
          const name = row["indexname"];
          if (typeof name !== "string") {
            panic("The cloned rank index has no name");
          }
          // db-await-in-loop: replace the finite cloned rank-index catalog with its online declaration.
          await db.execute(sql`DROP INDEX ${schema}.${sql.identifier(name)}`);
        }
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
        const subtreeClones =
          await db.execute(sql`SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schemaName} AND tablename = 'case_law_provision_citations'
            AND indexdef LIKE '%(jurisdiction, work_identifier, anchor COLLATE "C")%'`);
        for (const row of subtreeClones) {
          const name = row["indexname"];
          if (typeof name !== "string") {
            panic("The cloned citation subtree index has no name");
          }
          // db-await-in-loop: retain the migrated subtree index definition under its production name.
          await db.execute(sql`DROP INDEX ${schema}.${sql.identifier(name)}`);
        }
        const subtree = (
          await db.execute(sql`SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'case_law_provision_citations_work_subtree_idx'`)
        ).at(0)?.["indexdef"];
        if (typeof subtree !== "string") {
          panic("The migrated provision subtree index is absent");
        }
        await db.execute(
          sql.raw(
            subtree.replace(
              "ON public.case_law_provision_citations",
              () => `ON "${schemaName}".case_law_provision_citations`,
            ),
          ),
        );
        const sourceId = createSafeId<"caseLawSource">();
        await db.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: "provision-plan",
          name: "Synthetic provision plan",
        });
        const tx = asTestRaw<CaseLawPublicReadTransaction>(db);
        const measurements: { scope: number; page: number }[] = [];
        for (const decisions of [3000, 30_000]) {
          // db-await-in-loop: two fixed corpus sizes are the scaling experiment, never a request-path loop.
          await db.execute(
            sql`TRUNCATE ${schema}.case_law_provision_citations, ${schema}.case_law_decisions, ${schema}.corpus_index_projection_states`,
          );
          await db.execute(sql`INSERT INTO case_law_decisions
            (id, source_id, case_number, court, country, language, decision_date, citation_authority)
            SELECT gen_random_uuid(), ${sourceId}::uuid, 'synthetic/' || n,
              'Synthetic court', 'CZE', 'cs', DATE '2020-01-01' + (n % 365), 0
            FROM generate_series(1, ${decisions}::int) n`);
          // Ten links per decision make a full citation scan substantially larger
          // than the result page. Exactly one link cites the requested provision.
          await db.execute(sql`INSERT INTO case_law_provision_citations
            (id, decision_id, jurisdiction, work_identifier, work_number, work_year,
             work_collection, unit, section, subsection, anchor, decision_date,
             sentence_text, span_start, span_end, confidence)
            SELECT gen_random_uuid(), d.id, 'CZE', '2/1993 Sb.', 2, 1993,
              'Sb.', 'article', CASE WHEN n = 0 THEN 36 ELSE 100 + n END, '1',
              CASE WHEN n = 0 THEN 'cl_36-odst_1' ELSE 'cl_' || (100 + n) || '-odst_1' END,
              d.decision_date, repeat('synthetic citation sentence ', 12), n * 100, n * 100 + 20, 1
            FROM case_law_decisions d CROSS JOIN generate_series(0, 9) n`);
          await db.execute(sql`INSERT INTO corpus_index_projection_states
            (family, generation, entity_id, desired_action, desired_epoch,
             desired_fingerprint, desired_index_id, applied_action, applied_epoch,
             applied_fingerprint, applied_index_id, applied_revision, applied_at)
            SELECT 'case_law', ${GENERATION}, id, 'upsert', 1,
              repeat('a', 64), ${corpusIndexId(GENERATION, "CZE")}, 'upsert', 1,
              repeat('a', 64), ${corpusIndexId(GENERATION, "CZE")}, gen_random_uuid(),
              TIMESTAMPTZ '2026-01-01 00:00:00+00'
            FROM case_law_decisions`);
          await db.execute(sql`VACUUM (ANALYZE) ${schema}.case_law_decisions`);
          await db.execute(
            sql`VACUUM (ANALYZE) ${schema}.case_law_provision_citations`,
          );
          await db.execute(
            sql`VACUUM (ANALYZE) ${schema}.corpus_index_projection_states`,
          );
          await db.execute(sql`ANALYZE ${schema}.case_law_sources`);
          await db.execute(
            sql`SELECT set_config('statement_timeout', ${`${PUBLIC_READ_STATEMENT_TIMEOUT_MS.search}ms`}, false)`,
          );
          captured.length = 0;
          expect(
            await readCaseLawProvisionScope(tx, {
              jurisdiction: "CZE",
              provision: PROVISION,
              idSetMax: SCOPE_LIMIT,
            }),
          ).toEqual({ type: "broad" });
          expect(captured).toHaveLength(1);
          const scope =
            captured.at(0) ?? panic("The scope query was not captured");
          const scopePlan = explainRoot(
            await client.unsafe(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scope.query}`,
              scope.params,
            ),
          );
          for (const scan of citationScans(scopePlan)) {
            expect(String(scan["Index Name"])).toContain("work_subtree");
            expect(Number(scan["Actual Rows"])).toBeLessThanOrEqual(
              SCOPE_LIMIT + 1,
            );
          }
          const pageQuery = provisionDecisionPageQuery(tx, {
            body: { country: "CZE", query: "", provision: PROVISION },
            generation: GENERATION,
            after: undefined,
            orderBy: [
              desc(publishedCaseLawDecisions.citationAuthority),
              desc(publishedCaseLawDecisions.id),
            ],
            limit: PAGE_SIZE + 1,
          });
          const rows = await pageQuery;
          expect(rows).toHaveLength(PAGE_SIZE + 1);
          const pagePlan = explainRoot(
            await db.execute(
              sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${pageQuery.getSQL()}`,
            ),
          );
          expect(
            nodesOf(pagePlan).some((node) => node["Index Name"] === index.name),
          ).toBe(true);
          for (const scan of citationScans(pagePlan)) {
            expect(Number(scan["Actual Rows"])).toBeLessThanOrEqual(1);
            expect(Number(scan["Actual Loops"])).toBeLessThanOrEqual(
              PAGE_SIZE + 1,
            );
          }
          measurements.push({
            scope: readBlocks(scopePlan),
            page: readBlocks(pagePlan),
          });
          await db.execute(sql`SET statement_timeout = 0`);
        }
        const small =
          measurements.at(0) ?? panic("The small corpus was not measured");
        const large =
          measurements.at(1) ?? panic("The large corpus was not measured");
        // Additional B-tree height is allowed; reading the extra 270,000 links is not.
        expect(large.scope).toBeLessThanOrEqual(small.scope * 1.2 + 16);
        expect(large.page).toBeLessThanOrEqual(small.page * 1.2 + 16);
        expect(large.scope).toBeLessThan(1024);
        expect(large.page).toBeLessThan(1024);
        console.log("provision search shared blocks", measurements);
      } finally {
        await db.execute(sql`SET statement_timeout = 0`);
        await db.execute(sql`SET search_path TO public`);
        await db.execute(
          sql`DROP VIEW IF EXISTS pg_temp.case_law_published_decisions`,
        );
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 120_000);
});
