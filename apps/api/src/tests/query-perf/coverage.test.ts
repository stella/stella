import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getViewConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  publishedCaseLawDecisions,
  unredactedCaseLawDecisions,
} from "@/api/db/schema";
import { readCaseLawCoverageSourcesQuery } from "@/api/handlers/case-law/decisions/coverage";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  CASE_LAW_COVERAGE_COURT_INDEX,
  CASE_LAW_COVERAGE_FILING_DATE_INDEX,
  CASE_LAW_COVERAGE_INDEX,
} from "@/api/lib/case-law/coverage-index";
import { READ_BUDGETS } from "@/api/lib/db/read-budgets";
import { CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  budgetProblem,
  metricsFromPlan,
  scaleViolations,
  sumMetrics,
} from "./measurement";
import plannerSettings from "./planner-settings.json" with { type: "json" };
import { READ_BUDGET_PROFILES } from "./registry";
import {
  assertPlannerSettings,
  QUERY_PERF_CONNECTION_SETTINGS,
} from "./settings";

const SEED_CHUNK_ROWS = 20_000;
const COVERAGE_BUDGET_ID = "statement.caseLaw.coverageSources";

const enabled = process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true";

describe.skipIf(!enabled)("coverage refresh read budget", () => {
  test("coverage reads stay bounded at both corpus sizes, including rejected filing dates", async () => {
    const sizes: number[] = [];
    const measuredIds = new Set<string>();
    for (const rows of [60_000, 120_000]) {
      const databaseUrl =
        process.env["DATABASE_URL"] ??
        panic("DATABASE_URL required for coverage query perf");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const captured: { text: string; params: unknown[] }[] = [];
        const { db, sql: client } = openClient({
          max: 1,
          connection: {
            ...QUERY_PERF_CONNECTION_SETTINGS,
            statement_timeout: CASE_LAW_COVERAGE_REFRESH_STATEMENT_TIMEOUT_MS,
          },
          logger: {
            logQuery: (text, params) => {
              captured.push({ text, params });
            },
          },
        });
        for (const [name, value] of Object.entries(plannerSettings)) {
          // db-await-in-loop: apply the committed fixed planner settings to the fixture's single session.
          await db.execute(sql`SELECT set_config(${name}, ${value}, false)`);
        }
        await db.transaction(
          async (tx) => await assertPlannerSettings(tx, "owner"),
        );
        const schemaName = `coverage_budget_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        const schema = sql.identifier(schemaName);
        await db.execute(sql`CREATE SCHEMA ${schema}`);
        try {
          for (const table of [
            "case_law_sources",
            "case_law_decisions",
            "case_law_browse_facet_counts",
          ]) {
            // db-await-in-loop: three fixed fixture tables cloned with their production indexes.
            await db.execute(
              sql`CREATE TABLE ${schema}.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
            );
          }
          await db.execute(sql`SET search_path TO ${schema}, public`);
          const dialect = new PgDialect();
          for (const view of [
            publishedCaseLawDecisions,
            unredactedCaseLawDecisions,
          ]) {
            const config = getViewConfig(view);
            // db-await-in-loop: two production publication views over the cloned tables.
            await db.execute(
              sql`CREATE VIEW ${schema}.${sql.identifier(config.name)} AS (${sql.raw(dialect.sqlToQuery(config.query).sql)})`,
            );
          }
          for (const index of [
            CASE_LAW_COVERAGE_INDEX,
            CASE_LAW_COVERAGE_FILING_DATE_INDEX,
            CASE_LAW_COVERAGE_COURT_INDEX,
          ]) {
            // db-await-in-loop: install the production online coverage indexes in the isolated fixture.
            await db.execute(
              sql.raw(
                index.createSql
                  .replace(
                    "CREATE INDEX CONCURRENTLY",
                    "CREATE INDEX IF NOT EXISTS",
                  )
                  .replace(
                    'public."case_law_decisions"',
                    () => `"${schemaName}"."case_law_decisions"`,
                  ),
              ),
            );
          }
          await db.execute(sql`INSERT INTO case_law_sources (id, adapter_key, name)
          SELECT ('01990000-eeee-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'coverage-budget-' || n, 'Coverage fixture' FROM generate_series(1, 4) n`);
          for (let first = 1; first <= rows; first += SEED_CHUNK_ROWS) {
            const last = Math.min(first + SEED_CHUNK_ROWS - 1, rows);
            // db-await-in-loop: bounded seed chunks keep index predicate evaluation inside the production statement timeout.
            await db.execute(sql`INSERT INTO case_law_decisions
          (id, source_id, case_number, court, country, language, decision_date, fulltext)
          SELECT gen_random_uuid(), s.id,
            CASE WHEN s.adapter_key = 'coverage-budget-3' THEN '1 Cdo ' || n || '/2025' ELSE 'fixture/' || n END,
            'Court ' || (n % 30), 'CZE', 'cs', DATE '2000-01-01', 'Fixture text'
          FROM case_law_sources s CROSS JOIN generate_series(${first}, ${last}) n WHERE s.adapter_key <> 'coverage-budget-4'`);
          }
          await db.execute(sql`INSERT INTO case_law_decisions (id, source_id, case_number, court, country, language, decision_date, fulltext)
          SELECT gen_random_uuid(), id, 'fixed/' || n, 'Fixed court', 'CZE', 'cs', DATE '2000-01-01', 'Fixture text'
          FROM case_law_sources CROSS JOIN generate_series(1, 20) n WHERE adapter_key = 'coverage-budget-4'`);
          await db.execute(sql`INSERT INTO case_law_browse_facet_counts (kind, country, source_id, value, total)
          SELECT 'court', 'CZE', id, 'Court ' || n, ${rows / 30} FROM case_law_sources CROSS JOIN generate_series(0, 29) n
          WHERE adapter_key <> 'coverage-budget-4'`);
          for (const table of [
            "case_law_sources",
            "case_law_decisions",
            "case_law_browse_facet_counts",
          ]) {
            // db-await-in-loop: VACUUM cannot share statements or transactions; three fixed tables.
            await db.execute(sql`VACUUM (ANALYZE) ${sql.identifier(table)}`);
          }
          captured.length = 0;
          const sources = await readCaseLawCoverageSourcesQuery(
            asTestRaw<CaseLawPublicReadTransaction>(db),
          );
          const statements = captured.slice();
          expect(statements).toHaveLength(2);
          expect(sources).toHaveLength(4);
          for (const source of sources) {
            const expected =
              source.adapterKey === "coverage-budget-4" ? 20 : rows;
            expect(source.publishedDecisions).toBe(expected);
            expect(
              source.courts.reduce((sum, court) => sum + court.decisions, 0),
            ).toBe(expected);
          }
          expect(
            sources.find(
              ({ adapterKey }) => adapterKey === "coverage-budget-3",
            ),
          ).toMatchObject({ decisionYearFrom: null, decisionYearTo: null });
          expect(
            sources.find(
              ({ adapterKey }) => adapterKey === "coverage-budget-1",
            ),
          ).toMatchObject({ decisionYearFrom: 2000, decisionYearTo: 2000 });
          const samples = [];
          for (let sample = 0; sample <= 5; sample++) {
            const metrics = [];
            for (const statement of statements) {
              // db-await-in-loop: sequential cache warmup and five measurements of the actual reader statements.
              const result = await client.unsafe(
                `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
                statement.params,
              );
              const first = result.at(0);
              const documents: unknown = isRecord(first)
                ? first["QUERY PLAN"]
                : undefined;
              const plan: unknown = Array.isArray(documents)
                ? documents.at(0)
                : undefined;
              if (
                !Array.isArray(documents) ||
                documents.length !== 1 ||
                !isRecord(plan) ||
                !isRecord(plan["Plan"])
              ) {
                panic(
                  "Coverage measurement requires exactly one analyzed plan document",
                );
              }
              const document = { ...plan, Plan: plan["Plan"] };
              metrics.push(metricsFromPlan(document));
              if (sample === 5) {
                console.info(
                  JSON.stringify({
                    event: "coverage_read_plan",
                    rows,
                    plan: document,
                  }),
                );
              }
            }
            if (sample !== 0) {
              samples.push(sumMetrics(metrics));
            }
          }
          const measured = {
            sharedBlocks: Math.max(
              ...samples.map(({ sharedBlocks }) => sharedBlocks),
            ),
            executionTimeMs: Math.max(
              ...samples.map(({ executionTimeMs }) => executionTimeMs),
            ),
          };
          measuredIds.add(COVERAGE_BUDGET_ID);
          sizes.push(measured.sharedBlocks);
          console.info(
            JSON.stringify({
              event: "coverage_read_budget",
              rows,
              ...measured,
            }),
          );
          expect(budgetProblem(COVERAGE_BUDGET_ID, measured)).toBeUndefined();
          expect(measured.sharedBlocks).toBeLessThanOrEqual(
            READ_BUDGETS[COVERAGE_BUDGET_ID].pages,
          );
        } finally {
          await db.execute(sql`SET search_path TO public`);
          await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    }
    expect([...measuredIds].toSorted()).toEqual(
      Object.entries(READ_BUDGET_PROFILES)
        .filter(([, profile]) => profile === "coverage")
        .map(([id]) => id)
        .toSorted(),
    );
    const [size, double] = sizes;
    expect(size).toBeDefined();
    expect(double).toBeDefined();
    expect(
      scaleViolations({
        size: size ?? panic("Missing first measurement"),
        double: double ?? panic("Missing second measurement"),
      }),
    ).toEqual([]);
  }, 240_000); // timeout: two production-shape fixtures seed 540,000 decisions in bounded chunks before the measured reads.
});
