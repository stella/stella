import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawPublishedDecisionsFixtureSql } from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BACKLOG_ROWS = 200_000;
const HOT_MONTH_ROWS = 40_000;
const CHANGE_ROW_BUDGET = 1000;
const COUNTRY_COUNT = 3;
const MONTH_COUNT = 24;
const STATEMENT_HANG_GUARD_MS = 30_000;

type RefreshDb = Parameters<typeof refreshCaseLawSitemapShards>[0];

describe.skipIf(!enabled || !databaseUrl)(
  "sitemap backlog drain (postgres)",
  () => {
    // timeout: seeds a large PostgreSQL queue and drains it through hundreds of committed ticks.
    test("ticks read and retire only their row budget while coalescing a large backlog", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL required for sitemap backlog proof");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const sent: string[] = [];
        const { db } = openClient({
          max: 1,
          logger: {
            logQuery: (text) => {
              sent.push(text);
            },
          },
        });
        const schemaName = `sitemap_backlog_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        const schema = sql.identifier(schemaName);
        await db.execute(sql`CREATE SCHEMA ${schema}`);
        try {
          for (const table of [
            "case_law_sources",
            "case_law_decisions",
            "case_law_sitemap_changes",
            "case_law_sitemap_drain_progress",
            "case_law_sitemap_shards",
            "case_law_browse_facet_counts",
            "case_law_coverage_summaries",
            "case_law_sitemap_shard_counts",
            "case_law_source_arrivals",
          ]) {
            // Clone the refresh tables and removal fence with their migrated indexes.
            await db.execute(
              sql`CREATE TABLE ${schema}.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
            );
          }
          await db.execute(sql`SET search_path TO ${schema}, public`);
          // The drain must advance without relying on background vacuum timing.
          await db.execute(
            sql`ALTER TABLE ${schema}.case_law_sitemap_changes SET (autovacuum_enabled = false)`,
          );
          await db.execute(caseLawPublishedDecisionsFixtureSql);
          await db.execute(sql`
          INSERT INTO case_law_sources (id, adapter_key, name, enabled)
          VALUES ('00000000-0000-4000-8000-000000000001', 'sitemap-backlog-fixture', 'Sitemap backlog fixture', false)
        `);
          // Each country-month has a decision, so every recount also publishes a shard.
          await db.execute(sql`
          INSERT INTO case_law_decisions
            (id, source_id, source_document_id, country, language, court, case_number, decision_date, metadata)
          SELECT md5(i::text)::uuid, '00000000-0000-4000-8000-000000000001'::uuid,
            i::text, (ARRAY['XBA', 'XBB', 'XBC'])[1 + i % ${COUNTRY_COUNT}], 'xx', 'Fixture court', i::text,
            ('1900-01-01'::date + make_interval(months => (i / ${COUNTRY_COUNT})::int))::date, '{}'::jsonb
          FROM generate_series(0, ${COUNTRY_COUNT * MONTH_COUNT - 1}) AS i
        `);
          // xact is distinct per row to model independently committed changes without
          // spending the test on hundreds of thousands of fixture transactions.
          await db.execute(sql`
          INSERT INTO case_law_sitemap_changes (country, year, month, xact)
          SELECT (ARRAY['XBA', 'XBB', 'XBC'])[1 + target % ${COUNTRY_COUNT}],
            to_char('1900-01-01'::date + make_interval(months => (target / ${COUNTRY_COUNT})::int), 'YYYY'),
            to_char('1900-01-01'::date + make_interval(months => (target / ${COUNTRY_COUNT})::int), 'MM'),
            change_xact::text::xid8
          FROM (
            SELECT 0 AS target, i AS change_xact FROM generate_series(1, ${HOT_MONTH_ROWS}) AS i
            UNION ALL
            SELECT 1 + i % ${COUNTRY_COUNT * MONTH_COUNT - 1},
              1 + i / ${COUNTRY_COUNT * MONTH_COUNT - 1}
            FROM generate_series(0, ${BACKLOG_ROWS - HOT_MONTH_ROWS - 1}) AS i
          ) AS changes
        `);
          // Advance real transaction visibility beyond the fixture's reused xid
          // range (one xid may legitimately touch all 72 months).
          await db.execute(sql`
          CREATE PROCEDURE ${schema}.advance_fixture_xids() LANGUAGE plpgsql AS $procedure$
          BEGIN
            FOR step IN 1..${sql.raw(String(HOT_MONTH_ROWS))} LOOP
              PERFORM pg_current_xact_id();
              COMMIT;
            END LOOP;
          END
          $procedure$
        `);
          await db.execute(sql`SET synchronous_commit = off`);
          await db.execute(sql`CALL ${schema}.advance_fixture_xids()`);
          await db.execute(sql`SET synchronous_commit = on`);
          await db.execute(sql`ANALYZE case_law_sitemap_changes`);
          await db.execute(sql`ANALYZE case_law_decisions`);

          const dialect = new PgDialect();
          const ticks: {
            read: number;
            statements: number;
            elapsedMs: number;
            months: number;
          }[] = [];
          let read = 0;
          let measurementStatements = 0;
          const retirementPlans: {
            sharedBlocks: number;
            executionTimeMs: number;
            rows: number;
            hotMonth: boolean;
            evidence: string;
          }[] = [];
          const recordingDb = asTestRaw<RefreshDb>({
            transaction: async (work: (tx: unknown) => Promise<unknown>) =>
              await db.transaction(
                async (tx) =>
                  await work(
                    new Proxy(tx, {
                      get: (target, property, receiver) =>
                        property === "execute"
                          ? async (query: SQL) => {
                              const rendered = dialect.sqlToQuery(query);
                              if (
                                rendered.sql.includes(
                                  "WITH retiring AS MATERIALIZED",
                                )
                              ) {
                                const candidateSql = rendered.sql.replace(
                                  /DELETE FROM[\s\S]*$/u,
                                  "SELECT * FROM retiring",
                                );
                                const candidate = sql.join(
                                  candidateSql
                                    .split(/(\$[0-9]+)/gu)
                                    .map((part) =>
                                      /^\$[0-9]+$/u.test(part)
                                        ? sql`${rendered.params.at(Number(part.slice(1)) - 1)}`
                                        : sql.raw(part),
                                    ),
                                  sql.raw(""),
                                );
                                const explained = executedRows(
                                  await target.execute(
                                    sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate}`,
                                  ),
                                ).at(0);
                                measurementStatements += 1;
                                const document =
                                  isRecord(explained) &&
                                  Array.isArray(explained["QUERY PLAN"])
                                    ? explained["QUERY PLAN"].at(0)
                                    : undefined;
                                const plan = isRecord(document)
                                  ? document["Plan"]
                                  : undefined;
                                if (
                                  !isRecord(document) ||
                                  !isRecord(plan) ||
                                  typeof plan["Shared Hit Blocks"] !==
                                    "number" ||
                                  typeof plan["Shared Read Blocks"] !==
                                    "number" ||
                                  typeof document["Execution Time"] !==
                                    "number" ||
                                  typeof plan["Actual Rows"] !== "number"
                                ) {
                                  console.info(
                                    "SITEMAP_PLAN_EVIDENCE",
                                    JSON.stringify(explained),
                                  );
                                  panic("Missing retirement plan metrics");
                                }
                                const planText = JSON.stringify(plan);
                                const sharedBlocks =
                                  plan["Shared Hit Blocks"] +
                                  plan["Shared Read Blocks"];
                                if (
                                  !planText.includes('"Node Type":"Limit"') ||
                                  !/Index(?: Only)? Scan/u.test(planText) ||
                                  planText.includes("Seq Scan") ||
                                  planText.includes('"Node Type":"Sort"') ||
                                  sharedBlocks > 2 * CHANGE_ROW_BUDGET + 100
                                ) {
                                  console.info(
                                    "SITEMAP_PLAN_EVIDENCE",
                                    JSON.stringify({
                                      shape: "current",
                                      statement: candidateSql,
                                      params: rendered.params,
                                      evidence: document,
                                    }),
                                  );
                                  const diagnosticShapes = {
                                    withoutCursor: candidateSql.replace(
                                      /AND xact > \$[0-9]+::xid8\s*/u,
                                      "",
                                    ),
                                    withMidpointCursor: candidateSql.replace(
                                      /xact > \$[0-9]+::xid8/u,
                                      () =>
                                        `xact > '${HOT_MONTH_ROWS / 2}'::xid8`,
                                    ),
                                  };
                                  for (const [
                                    shape,
                                    statement,
                                  ] of Object.entries(diagnosticShapes)) {
                                    const diagnostic = sql.join(
                                      statement
                                        .split(/(\$[0-9]+)/gu)
                                        .map((part) =>
                                          /^\$[0-9]+$/u.test(part)
                                            ? sql`${rendered.params.at(Number(part.slice(1)) - 1)}`
                                            : sql.raw(part),
                                        ),
                                      sql.raw(""),
                                    );
                                    const evidence = executedRows(
                                      await target.execute(
                                        sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${diagnostic}`,
                                      ),
                                    );
                                    console.info(
                                      "SITEMAP_PLAN_EVIDENCE",
                                      JSON.stringify({
                                        shape,
                                        statement,
                                        params: rendered.params,
                                        evidence,
                                      }),
                                    );
                                  }
                                }

                                expect(planText).toContain(
                                  '"Node Type":"Limit"',
                                );
                                expect(planText).toMatch(
                                  /Index(?: Only)? Scan/u,
                                );
                                expect(planText).not.toContain("Seq Scan");
                                expect(planText).not.toContain(
                                  '"Node Type":"Sort"',
                                );
                                expect(sharedBlocks).toBeLessThanOrEqual(
                                  2 * CHANGE_ROW_BUDGET + 100,
                                );
                                retirementPlans.push({
                                  sharedBlocks,
                                  executionTimeMs: document["Execution Time"],
                                  rows: plan["Actual Rows"],
                                  evidence: JSON.stringify(document),
                                  hotMonth:
                                    rendered.params.at(0) === "XBA" &&
                                    rendered.params.at(1) === "1900" &&
                                    rendered.params.at(2) === "01",
                                });
                                const deletePlan = executedRows(
                                  await target.execute(
                                    sql`EXPLAIN (FORMAT JSON) ${query}`,
                                  ),
                                );
                                measurementStatements += 1;
                                if (
                                  JSON.stringify(deletePlan).includes(
                                    '"Node Type":"Seq Scan"',
                                  )
                                ) {
                                  console.info(
                                    "SITEMAP_PLAN_EVIDENCE",
                                    JSON.stringify({
                                      shape: "retirement-delete",
                                      statement: rendered.sql,
                                      params: rendered.params,
                                      candidateEvidence: document,
                                      deletePlan,
                                    }),
                                  );
                                }
                                expect(
                                  JSON.stringify(deletePlan),
                                ).not.toContain('"Node Type":"Seq Scan"');
                              }
                              const result = await target.execute(query);
                              if (
                                /SELECT\s+(?:id,\s*)?country,\s*year,\s*month\s+FROM/iu.test(
                                  rendered.sql,
                                ) ||
                                rendered.sql.includes(
                                  "WITH retiring AS MATERIALIZED",
                                )
                              ) {
                                read += executedRows(result).length;
                              }
                              return result;
                            }
                          : Reflect.get(target, property, receiver),
                    }),
                  ),
              ),
          });
          const countBacklog = async () => {
            const [row] = executedRows(
              await db.execute(
                sql`SELECT count(*)::int AS total FROM case_law_sitemap_changes`,
              ),
            );
            return isRecord(row) && typeof row["total"] === "number"
              ? row["total"]
              : panic("Missing fixture backlog count");
          };
          expect(await countBacklog()).toBe(BACKLOG_ROWS);
          const maxTicks =
            Math.ceil(
              (BACKLOG_ROWS + 3 * COUNTRY_COUNT * MONTH_COUNT) /
                (CHANGE_ROW_BUDGET - 1),
            ) + 1;
          let remaining = BACKLOG_ROWS;
          let recounts = 0;
          for (let tick = 0; tick < maxTicks && remaining > 0; tick += 1) {
            read = 0;
            measurementStatements = 0;
            sent.length = 0;
            const startedAt = performance.now();
            // db-await-in-loop: consecutive bounded ticks must make durable progress through the fixture queue.
            const outcome = await refreshCaseLawSitemapShards(recordingDb, {
              changeRowBudget: CHANGE_ROW_BUDGET,
            });
            ticks.push({
              read,
              statements: sent.length - measurementStatements,
              elapsedMs: performance.now() - startedAt,
              months: outcome.months,
            });
            recounts += outcome.months;
            expect(read).toBeLessThanOrEqual(CHANGE_ROW_BUDGET);
            // db-await-in-loop: independently count fixture state after each committed tick, outside its measured statements.
            const next = await countBacklog();
            expect(remaining - next).toBeLessThanOrEqual(CHANGE_ROW_BUDGET);
            expect(next).toBeLessThan(remaining);
            remaining = next;
          }
          expect(remaining).toBe(0);
          expect(recounts).toBe(COUNTRY_COUNT * MONTH_COUNT);
          expect(ticks.length).toBeLessThanOrEqual(maxTicks);
          expect(ticks).toHaveLength(
            Math.ceil(BACKLOG_ROWS / (CHANGE_ROW_BUDGET - 2)),
          );
          const first = ticks.at(0) ?? panic("Missing first tick");
          const last = ticks.at(-1) ?? panic("Missing last tick");
          const retirementTicks = ticks.filter(
            (tick) => tick.months === 0 && tick.read === CHANGE_ROW_BUDGET,
          );
          expect(retirementTicks.length).toBeGreaterThan(1);
          const retirementStatements =
            retirementTicks.at(0)?.statements ??
            panic("Missing retirement measurement");
          expect(
            retirementTicks.every(
              (tick) => tick.statements === retirementStatements,
            ),
          ).toBe(true);
          expect(
            ticks.every(
              (tick) =>
                Number.isFinite(tick.elapsedMs) &&
                tick.elapsedMs < STATEMENT_HANG_GUARD_MS * tick.statements,
            ),
          ).toBe(true);
          expect(
            await refreshCaseLawSitemapShards(recordingDb, {
              changeRowBudget: CHANGE_ROW_BUDGET,
            }),
          ).toMatchObject({ type: "refreshed", months: 0 });
          const fullRetirementPlans = retirementPlans.filter(
            (plan) => plan.rows === CHANGE_ROW_BUDGET - 1 && plan.hotMonth,
          );
          const firstRetirement =
            fullRetirementPlans.at(0) ??
            panic("Missing first full retirement plan");
          const lastRetirement =
            fullRetirementPlans.at(-1) ??
            panic("Missing last full retirement plan");
          console.info(
            "SITEMAP_PLAN_EVIDENCE first hot-month batch",
            firstRetirement.evidence,
          );
          console.info(
            "SITEMAP_PLAN_EVIDENCE last hot-month batch",
            lastRetirement.evidence,
          );
          expect(lastRetirement.sharedBlocks).toBeLessThanOrEqual(
            firstRetirement.sharedBlocks + 100,
          );
          // A transaction can reserve a lower ID and commit after a recount.
          // Persisted retirement must leave its change for a fresh recount.
          const { db: writerDb } = openClient({ max: 1 });
          await writerDb.execute(sql`SET search_path TO ${schema}, public`);
          const opened = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const writing = writerDb.transaction(async (tx) => {
            await tx.execute(
              sql`INSERT INTO case_law_sitemap_changes (country, year, month) VALUES ('XBA', '1900', '01')`,
            );
            await tx.execute(
              sql`UPDATE case_law_decisions SET updated_at = '2030-01-01'::timestamptz WHERE country = 'XBA' AND decision_date = '1900-01-01'::date`,
            );
            opened.resolve(undefined);
            await release.promise;
          });
          await opened.promise;
          try {
            await db.execute(sql`
            INSERT INTO case_law_sitemap_changes (country, year, month, xact)
            VALUES ('XBA', '1900', '01', '1'::xid8), ('XBA', '1900', '01', '2'::xid8), ('XBA', '1900', '01', '3'::xid8)
          `);
            expect(
              await refreshCaseLawSitemapShards(recordingDb, {
                changeRowBudget: 2,
              }),
            ).toMatchObject({ months: 1 });
          } finally {
            release.resolve(undefined);
            await writing;
          }
          let laterRecounts = 0;
          for (let tick = 0; tick < 8; tick += 1) {
            // db-await-in-loop: resume persisted retirement after the lower-ID transaction commits.
            const outcome = await refreshCaseLawSitemapShards(recordingDb, {
              changeRowBudget: 2,
            });
            laterRecounts += outcome.months;
            if (outcome.type === "refreshed") {
              break;
            }
          }
          expect(await countBacklog()).toBe(0);
          expect(laterRecounts).toBe(1);
          const [updated] = executedRows(
            await db.execute(sql`
          SELECT last_modified_at::text AS last_modified FROM case_law_sitemap_shards
          WHERE country = 'XBA' AND year = '1900' AND month = '01'
        `),
          );
          expect(
            isRecord(updated) ? updated["last_modified"] : undefined,
          ).toMatch(/^2030-01-01/u);
          // Keep wall time diagnostic: shared-runner scheduling is not a scaling oracle.
          console.info("sitemap backlog drain measurements", {
            first,
            last,
            ticks: ticks.length,
            recounts,
            retirementStatements,
            firstRetirement,
            lastRetirement,
          });
        } finally {
          await db.execute(
            sql`DROP VIEW IF EXISTS pg_temp.case_law_published_decisions`,
          );
          await db.execute(sql`SET search_path TO public`);
          await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    }, 180_000);
  },
);
