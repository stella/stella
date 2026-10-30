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
import {
  CASE_LAW_COVERAGE_FILING_DATE_INDEX,
  CASE_LAW_COVERAGE_INDEXES,
} from "@/api/lib/case-law/coverage-index";
import { refreshPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facet-refresh";
import { LIMITS } from "@/api/lib/limits";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  explainRoot,
  indexedAccessPaths,
} from "@/api/tests/query-plans/plan-walker";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const COVERAGE_INDEX = CASE_LAW_COVERAGE_FILING_DATE_INDEX.name;
const FACET_INDEX = "case_law_browse_facet_counts_source_kind_idx";
const FACET_YEARS = 130;
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
        const facetIndex =
          CASE_LAW_COVERAGE_INDEXES.find(({ name }) => name === FACET_INDEX) ??
          panic("The coverage facet index is not registered");
        await db.execute(
          sql.raw(
            facetIndex.createSql
              .replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX")
              .replace(
                'public."case_law_browse_facet_counts"',
                () => `"${schemaName}"."case_law_browse_facet_counts"`,
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
        // Exercise both sides of the population union: one source falls back
        // to decisions, while another has enough materialized buckets to make
        // a global facet-table scan tempting and includes the blank bucket.
        await db.execute(sql`DELETE FROM case_law_browse_facet_counts
          WHERE kind = 'court' AND source_id = (
            SELECT id FROM case_law_sources WHERE adapter_key = 'coverage-plan-1'
          )`);
        await db.execute(sql`INSERT INTO case_law_browse_facet_counts
          (kind, country, source_id, value, total)
          SELECT 'court', 'CZE', sources.id,
            CASE WHEN n = 0 THEN '' ELSE 'Materialized court ' || n END,
            ${decisionsPerSource} + n
          FROM case_law_sources sources CROSS JOIN generate_series(0, 12) n
          WHERE sources.adapter_key = 'coverage-plan-2'`);
        await db.execute(sql`INSERT INTO case_law_browse_facet_counts
          (kind, country, source_id, value, total)
          SELECT 'year', 'CZE', sources.id, 'unused/' || n, 1
          FROM case_law_sources sources
          CROSS JOIN generate_series(1, ${FACET_YEARS}) n`);
        await db.execute(sql`VACUUM (ANALYZE) case_law_browse_facet_counts`);
        captured.length = 0;
        const rows = await readCaseLawCoverageSourcesQuery(
          asTestRaw<CaseLawPublicReadTransaction>(db),
        );
        const legacyRows = await db.execute(sql`SELECT sources.adapter_key,
          coalesce((
            WITH population AS (
              SELECT facets.value AS court, facets.total AS decisions
              FROM case_law_browse_facet_counts facets
              WHERE facets.kind = 'court' AND facets.source_id = sources.id
              UNION ALL
              SELECT decisions.court, 1 AS decisions
              FROM case_law_published_decisions decisions
              WHERE decisions.source_id = sources.id
                AND NOT EXISTS (
                  SELECT 1 FROM case_law_browse_facet_counts source_facets
                  WHERE source_facets.kind = 'court'
                    AND source_facets.source_id = sources.id
                  LIMIT 1
                )
            ), normalized AS (
              SELECT nullif(btrim(court), '') AS court, decisions FROM population
            ), grouped AS (
              SELECT court, sum(decisions)::integer AS decisions
              FROM normalized GROUP BY court
            ), ranked AS (
              SELECT *, row_number() OVER (ORDER BY decisions DESC, court ASC) AS position
              FROM grouped
            ), bucketed AS (
              SELECT CASE WHEN position <= ${LIMITS.caseLawFacetLimit} THEN court END AS court, decisions
              FROM ranked
            ), bounded AS (
              SELECT court, sum(decisions)::integer AS decisions
              FROM bucketed GROUP BY court
            )
            SELECT jsonb_agg(jsonb_build_object('court', court, 'decisions', decisions)
              ORDER BY decisions DESC, court ASC)
            FROM bounded
          ), '[]'::jsonb) AS courts
          FROM case_law_sources sources ORDER BY sources.adapter_key`);
        expect(
          JSON.stringify(
            rows.map(({ adapterKey, courts }) => ({ adapterKey, courts })),
          ),
        ).toBe(
          JSON.stringify(
            legacyRows.map((row) => ({
              adapterKey: row["adapter_key"],
              courts: row["courts"],
            })),
          ),
        );
        // The per-source endpoint read, one grouped pending-text count, then
        // the legacy result-identity statement above.
        expect(captured).toHaveLength(3);
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
        const facetProbes = indexedAccessPaths(
          root,
          "case_law_browse_facet_counts",
        ).filter(({ actualLoops }) => actualLoops !== 0);
        expect(facetProbes, planEvidence).toHaveLength(2);
        // No other executed read of the facet table, of any kind: a bitmap
        // path's index child names no relation, so both shapes count two.
        expect(
          planNodes(root).filter(
            (node) =>
              node["Relation Name"] === "case_law_browse_facet_counts" &&
              node["Actual Loops"] !== 0,
          ),
          planEvidence,
        ).toHaveLength(2);
        for (const probe of facetProbes) {
          expect(probe.indexNames, planEvidence).toContain(FACET_INDEX);
          expect(probe.indexConditions.join(" "), planEvidence).toContain(
            "source_id",
          );
          expect(probe.indexConditions.join(" "), planEvidence).toContain(
            "court",
          );
          expect(probe.actualLoops, planEvidence).toBe(SOURCES);
        }
        const probes = indexedAccessPaths(root, "case_law_decisions").filter(
          ({ actualLoops, indexNames }) =>
            actualLoops !== 0 && indexNames.includes(COVERAGE_INDEX),
        );
        expect(probes, planEvidence).toHaveLength(2);
        for (const probe of probes) {
          // The endpoint limits and actual scan work are asserted below.
          expect(probe.indexNames, planEvidence).toContain(COVERAGE_INDEX);
          expect(probe.indexConditions.join(" "), planEvidence).toContain(
            "source_id",
          );
          expect(probe.indexConditions.join(" "), planEvidence).toContain(
            "decision_date IS NOT NULL",
          );
        }
        const endpointLimits = planNodes(root).filter(
          (node) =>
            node["Node Type"] === "Limit" &&
            indexedAccessPaths(node, "case_law_decisions").some(
              ({ indexNames }) => indexNames.includes(COVERAGE_INDEX),
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
