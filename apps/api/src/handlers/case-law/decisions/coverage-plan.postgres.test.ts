import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getViewConfig, PgDialect } from "drizzle-orm/pg-core";

import { Temporal } from "@stll/time";

import {
  caseLawSources,
  publishedCaseLawDecisions,
  unredactedCaseLawDecisions,
} from "@/api/db/schema";
import { readCaseLawCoverageSourcesQuery } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { CASE_LAW_COVERAGE_FILING_DATE_INDEX } from "@/api/lib/case-law/coverage-index";
import { refreshPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facet-refresh";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const COVERAGE_INDEX = CASE_LAW_COVERAGE_FILING_DATE_INDEX.name;
const SOURCES = 3;
const SOURCE_DATE_SPAN = 5000;

const planNodes = (
  node: Record<string, unknown>,
): Record<string, unknown>[] => {
  const children = node["Plans"];
  if (children === undefined) {
    return [node];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("The coverage plan has malformed children");
  }
  return [node, ...children.flatMap(planNodes)];
};

describe.skipIf(!enabled)("published coverage bounds plan (postgres)", () => {
  const assertIndexedBounds = async (decisionsPerSource: number) => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("The enabled coverage plan test requires DATABASE_URL");
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
      const schemaName = `coverage_plan_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        for (const table of [
          "case_law_sources",
          "case_law_decisions",
          "case_law_search_documents",
          "case_law_browse_facet_counts",
        ]) {
          await db.execute(sql`CREATE TABLE ${schema}.${sql.identifier(table)}
            (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        }
        await db.execute(sql`SET search_path TO ${schema}, public`);
        // The reader selects through the decision views; recreate them over
        // the cloned table so they resolve to this schema, not to public.
        const dialect = new PgDialect();
        for (const view of [
          publishedCaseLawDecisions,
          unredactedCaseLawDecisions,
        ]) {
          // Both views are defined with `.as()`, so drizzle types the query
          // as present; an `.existing()` view would fail to compile here.
          const config = getViewConfig(view);
          const rendered = dialect.sqlToQuery(config.query);
          await db.execute(sql`CREATE VIEW ${schema}.${sql.identifier(config.name)}
            AS (${sql.raw(rendered.sql)})`);
        }
        // The coverage index is still online-only: exercise its production DDL
        // rather than depending on what this Postgres fixture has installed.
        const existing = await db.execute(sql`SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schemaName} AND tablename = 'case_law_decisions'
            AND indexdef LIKE '%(source_id, decision_date, id)%'`);
        for (const row of existing) {
          const indexName = row["indexname"];
          if (typeof indexName !== "string") {
            panic("The cloned coverage index has no name");
          }
          await db.execute(
            sql`DROP INDEX ${schema}.${sql.identifier(indexName)}`,
          );
        }
        const { createSql, definitionBody } =
          CASE_LAW_COVERAGE_FILING_DATE_INDEX;
        await db.execute(
          sql.raw(
            createSql
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
          WHERE pg_namespace.nspname = ${schemaName} AND pg_class.relname = ${COVERAGE_INDEX}`);
        expect(installed).toEqual([
          {
            definition: `CREATE INDEX ${COVERAGE_INDEX} ${definitionBody.replace("ON public.", () => `ON ${schemaName}.`)}`,
          },
        ]);
        await db.insert(caseLawSources).values(
          Array.from({ length: SOURCES }, (_, sourceIndex) => ({
            id: createSafeId<"caseLawSource">(),
            adapterKey: `coverage-plan-${sourceIndex}`,
            name: "Coverage plan fixture",
          })),
        );
        // Distinct source ranges make scanning a global date prefix costly;
        // each source must seek its own endpoint regardless of other sources.
        await db.execute(sql`INSERT INTO case_law_decisions
          (id, source_id, case_number, court, country, language, decision_date, fulltext)
          SELECT gen_random_uuid(), sources.id, 'published/' || n,
            'Plan court', 'CZE', 'cs',
            DATE '1970-01-01' + n + sources.source_index * ${SOURCE_DATE_SPAN}, 'Published text'
          FROM (
            SELECT id, (row_number() OVER (ORDER BY adapter_key) - 1)::integer AS source_index
            FROM case_law_sources
          ) sources CROSS JOIN generate_series(1, ${decisionsPerSource}) n`);
        await db.execute(sql`INSERT INTO case_law_decisions
          (id, source_id, case_number, court, country, language, decision_date, fulltext, redacted_at, metadata)
          SELECT gen_random_uuid(), sources.id, 'excluded/' || status || '/' || endpoint,
            'Plan court', 'CZE', 'cs', endpoint,
            CASE WHEN status = 'listing-only' THEN 'Excluded text' END,
            CASE WHEN status = 'withdrawn' THEN TIMESTAMPTZ '2026-01-01 00:00:00+00' END,
            CASE WHEN status = 'listing-only' THEN
              '{"_stellaPartialObservation":{"isListingOnly":true}}'::jsonb ELSE '{}'::jsonb END
          FROM case_law_sources sources
          CROSS JOIN (VALUES (DATE '1900-01-01'), (DATE '2010-01-01')) endpoints(endpoint)
          CROSS JOIN (VALUES ('withdrawn'), ('listing-only')) statuses(status)`);
        await db.execute(sql`INSERT INTO case_law_search_documents
          (decision_id, language, regconfig, searchable_text, tsv)
          SELECT id, 'cs', 'simple', fulltext, to_tsvector('simple', fulltext)
          FROM case_law_decisions WHERE case_number LIKE 'published/%'`);
        await db.execute(sql`ANALYZE case_law_search_documents`);
        await db.execute(sql`VACUUM (ANALYZE) case_law_decisions`);
        await db.execute(sql`ANALYZE case_law_sources`);

        await refreshPgFtsBrowseFacets(db);
        await db.execute(sql`INSERT INTO case_law_browse_facet_counts
          (kind, country, source_id, value, total)
          SELECT 'year', 'CZE', sources.id, 'unused/' || n, 1
          FROM case_law_sources sources
          CROSS JOIN generate_series(1, ${decisionsPerSource}) n`);
        await db.execute(sql`VACUUM (ANALYZE) case_law_browse_facet_counts`);
        captured.length = 0;
        const rows = await readCaseLawCoverageSourcesQuery(
          asTestRaw<CaseLawPublicReadTransaction>(db),
        );
        // The per-source endpoint read, then one grouped pending-text count
        // for the page's sources.
        expect(captured).toHaveLength(2);
        const statement =
          captured.at(0) ??
          panic("The production coverage SQL was not captured");
        const root = explainRoot(
          await client.unsafe(
            `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement.query}`,
            statement.params,
          ),
        );
        const planEvidence = JSON.stringify(
          { query: statement.query, plan: root },
          null,
          2,
        );
        const facetProbes = planNodes(root).filter(
          (node) =>
            node["Relation Name"] === "case_law_browse_facet_counts" &&
            node["Actual Loops"] !== 0,
        );
        expect(facetProbes, planEvidence).toHaveLength(2);
        for (const probe of facetProbes) {
          expect(["Index Scan", "Index Only Scan"], planEvidence).toContain(
            String(probe["Node Type"]),
          );
          expect(probe["Index Cond"], planEvidence).toContain("source_id");
          expect(probe["Index Cond"], planEvidence).toContain("court");
          expect(probe["Actual Rows"], planEvidence).toBe(1);
          expect(probe["Actual Loops"], planEvidence).toBe(SOURCES);
        }
        const probes = planNodes(root).filter(
          (node) =>
            node["Relation Name"] === "case_law_decisions" &&
            node["Actual Loops"] !== 0,
        );
        expect(probes, planEvidence).toHaveLength(2);
        for (const probe of probes) {
          expect(["Index Scan", "Index Only Scan"], planEvidence).toContain(
            String(probe["Node Type"]),
          );
          // The endpoint limits and actual scan work are asserted below.
          expect(probe["Index Name"], planEvidence).toBe(COVERAGE_INDEX);
          expect(probe["Index Cond"], planEvidence).toContain("source_id");
          expect(probe["Index Cond"], planEvidence).toContain(
            "decision_date IS NOT NULL",
          );
        }
        const endpointLimits = planNodes(root).filter(
          (node) =>
            node["Node Type"] === "Limit" &&
            planNodes(node).some(
              (child) => child["Index Name"] === COVERAGE_INDEX,
            ),
        );
        // Exclude the outer page limit, which owns both correlated probes.
        const limits = endpointLimits.filter(
          (node) => node["Actual Loops"] === SOURCES,
        );
        expect(limits, planEvidence).toHaveLength(2);
        for (const limit of limits) {
          expect(limit["Actual Rows"], planEvidence).toBe(1);
          const nodes = planNodes(limit);
          expect(
            nodes.some((node) =>
              ["Seq Scan", "Sort", "Aggregate"].includes(
                String(node["Node Type"]),
              ),
            ),
            planEvidence,
          ).toBe(false);
          const scan =
            nodes.find((node) => node["Index Name"] === COVERAGE_INDEX) ??
            panic("Missing endpoint scan");
          expect(scan["Actual Rows"], planEvidence).toBe(1);
          expect(scan["Actual Loops"], planEvidence).toBe(SOURCES);
        }
        expect(
          new Set(
            limits
              .flatMap(planNodes)
              .filter((node) => node["Index Name"] === COVERAGE_INDEX)
              .map((node) => node["Scan Direction"]),
          ),
          planEvidence,
        ).toEqual(new Set(["Forward", "Backward"]));
        expect(rows).toHaveLength(SOURCES);
        for (const [sourceIndex, row] of rows.entries()) {
          const firstDate = Temporal.PlainDate.from("1970-01-01").add({
            days: sourceIndex * SOURCE_DATE_SPAN + 1,
          });
          const lastDate = Temporal.PlainDate.from("1970-01-01").add({
            days: sourceIndex * SOURCE_DATE_SPAN + decisionsPerSource,
          });
          expect(row).toMatchObject({
            adapterKey: `coverage-plan-${sourceIndex}`,
            decisionYearFrom: firstDate.year,
            decisionYearTo: lastDate.year,
            pendingTextCount: 0,
            courts: [{ court: "Plan court", decisions: decisionsPerSource }],
          });
        }
      } finally {
        await db.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  };
  test.each([400, 4000])(
    "indexed bounds at %i decisions per source",
    assertIndexedBounds,
    120_000,
  );
});
