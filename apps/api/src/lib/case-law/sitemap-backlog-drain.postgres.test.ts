import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawPublishedDecisionsFixtureSql } from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BACKLOG_ROWS = 200_000;
const MAX_HOT_MONTH_ROWS = 40_000;
const CHANGE_ROW_BUDGET = 1000;
const DISCOVERY_TARGET_BUDGET = 64;
// Exact-month ticks need at most cursor bookkeeping, one recount/publication and one retirement per discovery.
const STATEMENTS_PER_TARGET_CEILING = 32;
const TICK_STATEMENT_OVERHEAD = 16;
const COUNTRY_COUNT = 3;
const MONTH_COUNT = 24;
const STATEMENT_HANG_GUARD_MS = 30_000;

type RefreshDb = Parameters<typeof refreshCaseLawSitemapShards>[0];

const planNodes = (value: unknown): Record<string, unknown>[] => {
  if (!isRecord(value)) {
    return panic("Invalid EXPLAIN plan node");
  }
  const children = value["Plans"];
  return [
    value,
    ...(Array.isArray(children) ? children.flatMap(planNodes) : []),
  ];
};

const assertMeasuredPagePlan = (explained: unknown, budget: number) => {
  const row = executedRows(explained).at(0);
  const documents = isRecord(row) ? row["QUERY PLAN"] : undefined;
  const document = Array.isArray(documents) ? documents.at(0) : undefined;
  if (!isRecord(document)) {
    return panic("Missing EXPLAIN document");
  }
  const nodes = planNodes(document["Plan"]);
  expect(
    nodes.some((node) =>
      /Sort|Bitmap|Hash Join/u.test(String(node["Node Type"])),
    ),
  ).toBe(false);
  const scans = nodes.filter(
    (node) =>
      node["Relation Name"] === "case_law_sitemap_changes" &&
      String(node["Node Type"]).includes("Scan"),
  );
  expect(scans.length).toBeGreaterThan(0);
  let candidateReads = 0;
  let deletionReads = 0;
  for (const scan of scans) {
    expect(scan["Node Type"]).toMatch(/^Index(?: Only)? Scan$/u);
    expect(scan["Scan Direction"]).toBe("Forward");
    const rows = scan["Actual Rows"];
    const loops = scan["Actual Loops"];
    if (typeof rows !== "number" || typeof loops !== "number") {
      panic("Missing actual scan counters");
    }
    if (scan["Alias"] === "changes") {
      deletionReads += rows * loops;
    } else {
      candidateReads += rows * loops;
    }
    const condition = scan["Index Cond"];
    if (typeof condition !== "string") {
      panic("Missing index range condition");
    }
    if (condition.includes("id = ANY")) {
      continue;
    }
    expect(condition).toMatch(/country = .*year = .*month = .*xact >/u);
  }
  expect(candidateReads).toBeLessThanOrEqual(budget);
  expect(deletionReads).toBeLessThanOrEqual(budget);
  const limits = nodes.filter((node) => node["Node Type"] === "Limit");
  expect(limits.length).toBeGreaterThanOrEqual(2);
  expect(limits.every((node) => node["Plan Rows"] === 1)).toBe(true);
  return document;
};

describe.skipIf(!enabled)("sitemap backlog drain (postgres)", () => {
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
          "case_law_sitemap_refresh_cursor",
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
        const readSafeXactMax = async () => {
          const snapshot = executedRows(
            await db.execute(
              sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS boundary`,
            ),
          ).at(0);
          if (!isRecord(snapshot) || typeof snapshot["boundary"] !== "string") {
            panic("Missing fixture visibility boundary");
          }
          return BigInt(snapshot["boundary"]) - 1n;
        };
        let safeXactMax = await readSafeXactMax();
        const minimumSafeXacts = Math.ceil(
          BACKLOG_ROWS / (COUNTRY_COUNT * MONTH_COUNT),
        );
        if (safeXactMax < BigInt(minimumSafeXacts)) {
          await db.execute(sql`CREATE PROCEDURE ${schema}.bootstrap_fixture_xids() LANGUAGE plpgsql AS $procedure$
            BEGIN FOR step IN 1..${sql.raw(String(minimumSafeXacts))} LOOP
              PERFORM pg_current_xact_id(); COMMIT;
            END LOOP; END $procedure$`);
          await db.execute(sql`CALL ${schema}.bootstrap_fixture_xids()`);
          safeXactMax = await readSafeXactMax();
        }
        if (safeXactMax < BigInt(minimumSafeXacts)) {
          panic(
            `Backlog fixture needs at least ${minimumSafeXacts} stable xids before snapshot xmin; observed ${safeXactMax}. Another transaction pins the cluster; run this fixture with cluster-exclusive scheduling.`,
          );
        }
        const hotMonthRows = Number(
          safeXactMax < BigInt(MAX_HOT_MONTH_ROWS)
            ? safeXactMax
            : BigInt(MAX_HOT_MONTH_ROWS),
        );
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
            SELECT 0 AS target, i AS change_xact FROM generate_series(1, ${hotMonthRows}) AS i
            UNION ALL
            SELECT 1 + i % ${COUNTRY_COUNT * MONTH_COUNT - 1},
              1 + i / ${COUNTRY_COUNT * MONTH_COUNT - 1}
            FROM generate_series(0, ${BACKLOG_ROWS - hotMonthRows - 1}) AS i
          ) AS changes
        `);
        await db.execute(sql`ANALYZE case_law_sitemap_changes`);
        await db.execute(sql`ANALYZE case_law_decisions`);

        const dialect = new PgDialect();
        const ticks: {
          read: number;
          discoveries: number;
          retirementPages: number;
          statements: number;
          elapsedMs: number;
          months: number;
        }[] = [];
        let read = 0;
        let discoveries = 0;
        let retirementPages = 0;
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
                                "WITH RECURSIVE candidates AS",
                              )
                            ) {
                              const candidateSql = rendered.sql.replace(
                                /,\s*retired AS[\s\S]*$/u,
                                "SELECT * FROM candidates",
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
                                typeof plan["Shared Hit Blocks"] !== "number" ||
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
                                sharedBlocks > 8 * CHANGE_ROW_BUDGET + 100
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
                                      `xact > '${Math.floor(hotMonthRows / 2)}'::xid8`,
                                  ),
                                };
                                for (const [shape, statement] of Object.entries(
                                  diagnosticShapes,
                                )) {
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

                              expect(planText).toContain('"Node Type":"Limit"');
                              expect(planText).toMatch(/Index(?: Only)? Scan/u);
                              expect(planText).toContain(
                                '"Scan Direction":"Forward"',
                              );
                              expect(planText).toContain(
                                '"Relation Name":"case_law_sitemap_changes"',
                              );
                              expect(planText).toMatch(
                                /Index Cond.*country = .*year = .*month = .*xact >/u,
                              );
                              expect(planText).not.toContain("Bitmap");
                              expect(planText).not.toContain("Seq Scan");
                              expect(planText).not.toContain(
                                '"Node Type":"Sort"',
                              );
                              expect(sharedBlocks).toBeLessThanOrEqual(
                                8 * CHANGE_ROW_BUDGET + 100,
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
                              expect(JSON.stringify(deletePlan)).not.toContain(
                                '"Node Type":"Seq Scan"',
                              );
                              expect(JSON.stringify(deletePlan)).not.toContain(
                                "Bitmap",
                              );
                              expect(JSON.stringify(deletePlan)).not.toContain(
                                '"Node Type":"Sort"',
                              );
                              expect(JSON.stringify(deletePlan)).not.toContain(
                                '"Node Type":"Hash Join"',
                              );
                            }
                            const result = await target.execute(query);
                            if (
                              rendered.sql.includes(
                                "WITH RECURSIVE candidates AS",
                              )
                            ) {
                              retirementPages += 1;
                              const retirement = executedRows(result).at(0);
                              if (
                                !isRecord(retirement) ||
                                typeof retirement["candidates_read"] !==
                                  "number"
                              ) {
                                panic("Missing measured candidate count");
                              }
                              read += retirement["candidates_read"];
                            } else if (
                              rendered.sql.includes("change_rows_read")
                            ) {
                              discoveries += 1;
                              for (const row of executedRows(result)) {
                                if (
                                  !isRecord(row) ||
                                  typeof row["change_rows_read"] !== "number"
                                ) {
                                  panic("Missing discovery read counter");
                                }
                                read += row["change_rows_read"];
                              }
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
          Math.ceil(BACKLOG_ROWS / (CHANGE_ROW_BUDGET - 2)) +
          COUNTRY_COUNT * MONTH_COUNT;
        let remaining = BACKLOG_ROWS;
        let recounts = 0;
        for (let tick = 0; tick < maxTicks && remaining > 0; tick += 1) {
          read = 0;
          discoveries = 0;
          retirementPages = 0;
          measurementStatements = 0;
          sent.length = 0;
          const startedAt = performance.now();
          // db-await-in-loop: consecutive bounded ticks must make durable progress through the fixture queue.
          const outcome = await refreshCaseLawSitemapShards(recordingDb, {
            changeRowBudget: CHANGE_ROW_BUDGET,
            discoveryTargetBudget: DISCOVERY_TARGET_BUDGET,
          });
          ticks.push({
            read,
            discoveries,
            retirementPages,
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
        expect(ticks.length).toBeGreaterThanOrEqual(
          Math.ceil(BACKLOG_ROWS / CHANGE_ROW_BUDGET),
        );
        const first = ticks.at(0) ?? panic("Missing first tick");
        const last = ticks.at(-1) ?? panic("Missing last tick");
        const retirementTicks = ticks.filter(
          (tick) =>
            tick.months === 0 &&
            tick.read === CHANGE_ROW_BUDGET &&
            tick.discoveries === 1 &&
            tick.retirementPages === 1,
        );
        expect(retirementTicks.length).toBeGreaterThan(1);
        const retirementStatements =
          retirementTicks.at(0)?.statements ??
          panic("Missing retirement measurement");
        expect(retirementTicks.at(-1)?.statements).toBe(retirementStatements);
        for (const tick of ticks) {
          expect(tick.discoveries).toBeLessThanOrEqual(DISCOVERY_TARGET_BUDGET);
          expect(tick.retirementPages).toBeLessThanOrEqual(tick.discoveries);
          expect(tick.statements).toBeLessThanOrEqual(
            STATEMENTS_PER_TARGET_CEILING * DISCOVERY_TARGET_BUDGET +
              TICK_STATEMENT_OVERHEAD,
          );
          expect(tick.statements).toBeLessThanOrEqual(
            STATEMENTS_PER_TARGET_CEILING * tick.discoveries +
              TICK_STATEMENT_OVERHEAD,
          );
        }
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
          (plan) => plan.rows >= CHANGE_ROW_BUDGET - 2 && plan.hotMonth,
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

  // timeout: seeds two production-index fixtures and measures the actual retirement statement at populated boundaries.
  test("open retirement pages stay bounded at the failing range and across populated coverage boundaries", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required for retirement plan proof");
    }
    for (const shape of ["mixed", "hot"] as const) {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const schema = sql.identifier(
          `sitemap_page_${Bun.randomUUIDv7().replaceAll("-", "")}`,
        );
        await db.execute(sql`CREATE SCHEMA ${schema}`);
        try {
          for (const table of [
            "case_law_sources",
            "case_law_decisions",
            "case_law_sitemap_changes",
            "case_law_sitemap_drain_progress",
            "case_law_sitemap_refresh_cursor",
            "case_law_sitemap_shards",
            "case_law_browse_facet_counts",
            "case_law_coverage_summaries",
            "case_law_sitemap_shard_counts",
            "case_law_source_arrivals",
          ]) {
            await db.execute(
              sql`CREATE TABLE ${schema}.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
            );
          }
          await db.execute(sql`SET search_path TO ${schema}, public`);
          await db.execute(
            sql`ALTER TABLE ${schema}.case_law_sitemap_changes SET (autovacuum_enabled = false)`,
          );
          if (shape === "hot") {
            await db.execute(
              sql`INSERT INTO case_law_sitemap_changes (country, year, month, xact) SELECT 'XBA', '1900', '01', i::text::xid8 FROM generate_series(1, 200000) i`,
            );
          } else {
            await db.execute(sql`
              INSERT INTO case_law_sitemap_changes (country, year, month, xact)
              SELECT (ARRAY['XBA', 'XBB', 'XBC'])[1 + target % 3],
                to_char('1900-01-01'::date + make_interval(months => (target / 3)::int), 'YYYY'),
                to_char('1900-01-01'::date + make_interval(months => (target / 3)::int), 'MM'), change_xact::text::xid8
              FROM (SELECT 0 AS target, i AS change_xact FROM generate_series(1, 40000) i
                UNION ALL SELECT 1 + i % 71, 1 + i / 71 FROM generate_series(0, 159999) i) changes
            `);
          }
          await db.execute(sql`ANALYZE case_law_sitemap_changes`);
          await db.execute(sql`INSERT INTO case_law_sitemap_changes (country, year, month, xact)
            SELECT 'XBA', '1900', '01', i::text::xid8
            FROM generate_series(${shape === "hot" ? 200_001 : 40_001}::int, ${shape === "hot" ? 250_000 : 90_000}::int) i`);
          const dialect = new PgDialect();
          for (const lower of [0, 1998, 4154, 7808]) {
            await db.execute(
              sql`DELETE FROM case_law_sitemap_refresh_cursor WHERE slot = 0`,
            );
            await db.execute(sql`
              INSERT INTO case_law_sitemap_drain_progress (country, year, month, covered_before, retired_through, phase)
              VALUES ('XBA', '1900', '01', '8308'::xid8, ${String(lower)}::xid8, 'draining')
              ON CONFLICT (country, year, month) DO UPDATE SET covered_before = excluded.covered_before,
                retired_through = excluded.retired_through, phase = excluded.phase
            `);
            const captured: SQL[] = [];
            const captureDb = asTestRaw<RefreshDb>({
              transaction: async (work: (tx: unknown) => Promise<unknown>) =>
                await db.transaction(
                  async (tx) =>
                    await work(
                      new Proxy(tx, {
                        get: (target, property, receiver) =>
                          property === "execute"
                            ? async (query: SQL) => {
                                if (
                                  dialect
                                    .sqlToQuery(query)
                                    .sql.includes(
                                      "WITH RECURSIVE candidates AS",
                                    )
                                ) {
                                  captured.push(query);
                                  panic("Captured retirement before execution");
                                }
                                return await target.execute(query);
                              }
                            : Reflect.get(target, property, receiver),
                      }),
                    ),
                ),
            });
            expect(
              String(
                await rejectionOf(
                  refreshCaseLawSitemapShards(captureDb, {
                    changeRowBudget: CHANGE_ROW_BUDGET,
                  }),
                ),
              ),
            ).toContain("Captured retirement before execution");
            expect(captured).toHaveLength(1);
            const query =
              captured.at(0) ?? panic("Missing captured retirement SQL");
            const rendered = dialect.sqlToQuery(query);
            expect(rendered.params.slice(0, 4)).toEqual([
              "XBA",
              "1900",
              "01",
              String(lower),
            ]);
            const candidateText = rendered.sql.replace(
              /,\s*retired AS[\s\S]*$/u,
              "SELECT * FROM candidates",
            );
            expect(candidateText).not.toBe(rendered.sql);
            const candidate = sql.join(
              candidateText
                .split(/(\$[0-9]+)/gu)
                .map((part) =>
                  /^\$[0-9]+$/u.test(part)
                    ? sql`${rendered.params.at(Number(part.slice(1)) - 1)}`
                    : sql.raw(part),
                ),
              sql.raw(""),
            );
            const candidateEvidence = await db.execute(
              sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate}`,
            );
            console.info(
              "SITEMAP_PLAN_EVIDENCE",
              JSON.stringify({
                shape,
                lower,
                coverage: 8308,
                budget: 999,
                statement: candidateText,
                params: rendered.params,
                candidateEvidence,
              }),
            );
            const candidateDocument = assertMeasuredPagePlan(
              candidateEvidence,
              999,
            );
            const candidatePlan = candidateDocument["Plan"];
            expect(
              isRecord(candidatePlan) ? candidatePlan["Actual Rows"] : null,
            ).toBe(lower === 7808 ? 500 : 999);
            // One private session owns this rollback-only measurement transaction.
            await db.execute(sql`BEGIN`);
            try {
              const statementEvidence = await db.execute(
                sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
              );
              console.info(
                "SITEMAP_PLAN_EVIDENCE retirement",
                JSON.stringify({
                  shape,
                  lower,
                  coverage: 8308,
                  budget: 999,
                  statement: rendered.sql,
                  params: rendered.params,
                  statementEvidence,
                }),
              );
              assertMeasuredPagePlan(statementEvidence, 999);
            } finally {
              await db.execute(sql`ROLLBACK`);
            }
            if (lower === 7808) {
              const [retirement] = executedRows(await db.execute(query));
              expect(retirement).toMatchObject({
                candidates_read: 500,
                retired: 499,
                retired_through: "8307",
              });
              const [uncovered] = executedRows(
                await db.execute(
                  sql`SELECT count(*)::int AS total FROM case_law_sitemap_changes WHERE country = 'XBA' AND year = '1900' AND month = '01' AND xact >= '8308'::xid8`,
                ),
              );
              expect(isRecord(uncovered) ? uncovered["total"] : null).toBe(
                (shape === "hot" ? 250_000 : 90_000) - 8307,
              );
            }
          }
        } finally {
          await db.execute(sql`SET search_path TO public`);
          await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    }
  }, 180_000);
});
