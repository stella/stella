import { panic } from "better-result";
import type { SQL as BunSql } from "bun";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import { defaultConfig, initialBatchState } from "@stll/db-load-gate/health";

import {
  caseLawDecisions,
  caseLawSitemapShards,
  caseLawSources,
  databaseBackfillStates,
} from "@/api/db/schema";
import {
  listSitemapShardDecisionsHandler,
  listSitemapShardsHandler,
} from "@/api/handlers/case-law/decisions/sitemap";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { SITEMAP_RANGE_ROWS } from "@/api/lib/case-law/sitemap-shard-budget";
import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import {
  SITEMAP_ALL_BUCKET,
  sitemapRangeBucket,
} from "@/api/lib/case-law/sitemap-shard-sql";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawPublishedDecisionsFixtureSql } from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { CASE_LAW_SITEMAP_RANGE_ENROLLMENT } from "./case-law-sitemap-packing-enrollment";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import {
  ONLINE_MIGRATION_REPAIRS,
  runOnlineMigrations,
} from "./online-migrations";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
type RefreshDb = Parameters<typeof refreshCaseLawSitemapShards>[0];
/** A month that stays one file. */
const QUIET_MONTH_DECISIONS = 1000;
/** A month a dozen ranges long, its last one partly filled. */
const LARGE_MONTH_DECISIONS = 12 * SITEMAP_RANGE_ROWS + 37;
/** Undated decisions, one range and a bit. */
const UNDATED_DECISIONS = SITEMAP_RANGE_ROWS + 200;
const SEEDED =
  QUIET_MONTH_DECISIONS + LARGE_MONTH_DECISIONS + UNDATED_DECISIONS;
/** The shard lastmod every seeded decision carries but one per month. */
const SEEDED_UPDATE = new Date("2024-07-01T00:00:00Z");
const NEWEST_UPDATE = new Date("2024-07-02T09:30:00Z");

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

if (!databaseUrl || !enabled) {
  describe.skip("sitemap range enrollment (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(enabled && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("sitemap range enrollment (postgres)", () => {
    // timeout: seeds over twenty thousand decisions and reads every listed file through real PostgreSQL.
    test("enrolled months are cut into ranges that list every decision once, keep its lastmod, and read flat", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        let measuredQueries: string[] | undefined;
        const { db: isolated } = openClient({
          max: 1,
          logger: {
            logQuery: (query) => {
              measuredQueries?.push(query);
            },
          },
        });
        const schemaName = `sitemap_ranges_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        const schema = sql.identifier(schemaName);
        await isolated.execute(sql`CREATE SCHEMA ${schema}`);
        try {
          for (const table of [
            "database_backfill_states",
            "case_law_sources",
            "case_law_decisions",
            "case_law_sitemap_changes",
            "case_law_sitemap_shards",
            "case_law_sitemap_drain_progress",
            "case_law_sitemap_refresh_cursor",
            "case_law_browse_facet_counts",
            "case_law_coverage_summaries",
            "case_law_sitemap_shard_counts",
            "case_law_source_arrivals",
          ]) {
            await isolated.execute(
              sql`CREATE TABLE ${schema}.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
            );
          }
          await isolated.execute(sql`SET search_path TO ${schema}, public`);
          await isolated.execute(caseLawPublishedDecisionsFixtureSql);
          const copiedUnique = executedRows(
            await isolated.execute(sql`
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'case_law_sitemap_changes'::regclass AND contype = 'u'
          `),
          );
          expect(copiedUnique).toHaveLength(1);
          const copiedConstraint = copiedUnique.at(0);
          if (
            !isRecord(copiedConstraint) ||
            typeof copiedConstraint["conname"] !== "string"
          ) {
            panic("Missing copied sitemap uniqueness constraint");
          }
          await isolated.execute(
            sql`ALTER TABLE ${schema}.case_law_sitemap_changes RENAME CONSTRAINT ${sql.identifier(copiedConstraint["conname"])} TO case_law_sitemap_changes_month_xact_key`,
          );

          const sourceId = createSafeId<"caseLawSource">();
          await isolated.insert(caseLawSources).values({
            id: sourceId,
            adapterKey: "sitemap-range-fixture",
            name: "Sitemap range fixture",
            enabled: false,
          });
          // Decisions arrive interleaved across the three months, as a
          // corpus is ingested over years; the first of each month is the
          // newest written.
          await isolated.execute(sql`
            INSERT INTO case_law_decisions
              (id, source_id, case_number, court, country, language, language_group_key, decision_date, updated_at)
            SELECT md5('sitemap-range-' || i::text)::uuid, ${sourceId}::uuid,
              'sitemap-range-' || i::text, 'Fixture court', 'CZE', 'cs', 'sitemap-range-' || i::text,
              CASE
                WHEN i < ${QUIET_MONTH_DECISIONS} THEN '2024-06-01'::date + (i % 28)
                WHEN i < ${QUIET_MONTH_DECISIONS + LARGE_MONTH_DECISIONS} THEN '2026-06-01'::date + (i % 28)
                ELSE NULL
              END,
              CASE WHEN i IN (0, ${QUIET_MONTH_DECISIONS}, ${QUIET_MONTH_DECISIONS + LARGE_MONTH_DECISIONS})
                THEN ${NEWEST_UPDATE.toISOString()}::timestamptz
                ELSE ${SEEDED_UPDATE.toISOString()}::timestamptz END
            FROM generate_series(0, ${SEEDED - 1}::integer) AS i
          `);
          await isolated.execute(sql`ANALYZE case_law_decisions`);
          await isolated.execute(sql`ANALYZE case_law_sources`);
          const isolatedRefresh = asTestRaw<RefreshDb>(isolated);
          const readDb = asTestRaw<CaseLawPublicReadDb>(
            async (
              read: (tx: CaseLawPublicReadTransaction) => Promise<unknown>,
            ) =>
              await isolated.transaction(
                async (tx) =>
                  await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
              ),
          );
          // The listing before ranges: every month one file, as the protocol
          // ceiling left them. No change is pending.
          await isolated.execute(sql`
            INSERT INTO case_law_sitemap_shards (country, year, month, bucket, total, last_modified_at)
            SELECT country, coalesce(to_char(decision_date, 'YYYY'), 'undated'),
              coalesce(to_char(decision_date, 'MM'), '00'), 'all', count(*)::int,
              max(updated_at)
            FROM case_law_decisions GROUP BY 1, 2, 3
          `);
          const listedBefore = await listSitemapShardsHandler(readDb);
          if (!("items" in listedBefore)) {
            panic("Expected the listing before ranges");
          }
          expect(listedBefore.items).toHaveLength(3);
          expect(
            listedBefore.items.every(
              ({ lastmod }) => lastmod === dayOf(NEWEST_UPDATE),
            ),
          ).toBe(true);
          // A hundred more listed countries make the enrollment page.
          await isolated.execute(sql`
            INSERT INTO case_law_sitemap_shards (country, year, month, bucket, total, last_modified_at)
            SELECT 'X' || chr(65 + (i / 26)::int) || chr(65 + (i % 26)::int),
              '1800', '01', 'all', 1, ${NEWEST_UPDATE.toISOString()}::timestamptz
            FROM generate_series(0, 99) AS i
          `);
          await isolated.execute(sql`ANALYZE case_law_sitemap_shards`);

          const pageSizes: number[] = [];
          const repairQueries: string[] = [];
          const redirect = (statement: string) =>
            statement.replaceAll(
              /public\.(database_backfill_states|case_law_sitemap_changes|case_law_sitemap_shards)/gu,
              (_, table: string) => `${schemaName}.${table}`,
            );
          const reserveConnection = async (client: BunSql) => {
            const session = await client.reserve();
            return {
              execute: async (statement, params = []) => {
                repairQueries.push(statement);
                await session.unsafe(redirect(statement), [...params]);
              },
              query: async (statement, params = []) => {
                repairQueries.push(statement);
                const rows = await session.unsafe(redirect(statement), [
                  ...params,
                ]);
                if (statement.includes("WITH RECURSIVE countries AS")) {
                  pageSizes.push(rows.length);
                }
                return rows;
              },
              release: async () => await session.release(),
            } satisfies OnlineMigrationConnection;
          };
          const repairClient = openClient({ max: 1, idleTimeout: 0 }).sql;
          const observerClient = openClient({ max: 1, idleTimeout: 0 }).sql;
          const enroll = async () =>
            await runOnlineMigrations(
              { reserve: async () => await reserveConnection(repairClient) },
              {
                repairs: ONLINE_MIGRATION_REPAIRS.filter(
                  (repair) => repair === CASE_LAW_SITEMAP_RANGE_ENROLLMENT,
                ),
                indexGate: { ebs: { type: "disabled" }, log: () => undefined },
                reserveObserver: async () =>
                  await reserveConnection(observerClient),
                timing: { clock: () => 0, emit: () => undefined },
                log: () => undefined,
              },
            );
          expect(await enroll()).toEqual({ type: "complete" });
          const [checkpoint] = await isolated
            .select()
            .from(databaseBackfillStates)
            .where(
              eq(
                databaseBackfillStates.name,
                CASE_LAW_SITEMAP_RANGE_ENROLLMENT.name,
              ),
            );
          expect(checkpoint?.cursor).toBe("complete");
          expect(checkpoint?.batch).toEqual(initialBatchState(defaultConfig));
          expect(pageSizes).toEqual([100, 1]);

          const tickOptions = {
            changeRowBudget: 10_000,
            discoveryTargetBudget: 64,
          };
          let drained = await refreshCaseLawSitemapShards(
            isolatedRefresh,
            tickOptions,
          );
          for (
            let tick = 1;
            drained.type === "pending" && tick < 20;
            tick += 1
          ) {
            // db-await-in-loop: consecutive scheduler runs drain the enrolled countries
            drained = await refreshCaseLawSitemapShards(
              isolatedRefresh,
              tickOptions,
            );
          }
          expect(drained.type).toBe("refreshed");

          // A second enrollment is one completion read and queues nothing.
          repairQueries.length = 0;
          expect(await enroll()).toEqual({ type: "complete" });
          const completionQueries = repairQueries.filter(
            (statement) =>
              statement.includes("public.database_backfill_states") ||
              statement.includes("public.case_law_sitemap_changes") ||
              statement.includes("public.case_law_sitemap_shards"),
          );
          expect(completionQueries).toHaveLength(1);
          expect(completionQueries.at(0)).toContain("WHERE name = $1 LIMIT 1");

          const listed = await listSitemapShardsHandler(readDb);
          if (!("items" in listed)) {
            panic("Expected the listing after ranges");
          }
          const monthFiles = (year: string, month: string) =>
            listed.items.filter(
              (shard) =>
                shard.country === "cze" &&
                shard.year === year &&
                shard.month === month,
            );
          // The quiet month keeps its one file, its URL and its lastmod.
          expect(monthFiles("2024", "06")).toEqual(
            listedBefore.items.filter(({ year }) => year === "2024"),
          );
          const largeFiles = monthFiles("2026", "06");
          expect(largeFiles.map(({ bucket }) => bucket)).toEqual(
            Array.from(
              { length: Math.ceil(LARGE_MONTH_DECISIONS / SITEMAP_RANGE_ROWS) },
              (_, position) => sitemapRangeBucket(position),
            ),
          );
          expect(
            monthFiles("undated", "00").map(({ bucket }) => bucket),
          ).toEqual(["0000", "0001"]);
          // The whole large month is no longer a file of its own.
          expect(
            await listSitemapShardDecisionsHandler(
              {
                country: "cze",
                year: "2026",
                month: "06",
                bucket: SITEMAP_ALL_BUCKET,
              },
              readDb,
            ),
          ).toMatchObject({ code: 404 });

          // Every file of every month, read as a crawler reads them: each
          // decision listed exactly once, with the date it had, and each
          // file dated by its own newest decision, never later.
          const stored = new Map(
            (
              await isolated
                .select({
                  id: caseLawDecisions.id,
                  updatedAt: caseLawDecisions.updatedAt,
                })
                .from(caseLawDecisions)
            ).map(({ id, updatedAt }) => [id, updatedAt.toISOString()]),
          );
          const served: string[] = [];
          const statementsPerFile = new Set<number>();
          for (const file of listed.items.filter(
            ({ country }) => country === "cze",
          )) {
            const statements: string[] = [];
            measuredQueries = statements;
            // db-await-in-loop: one read per listed file, as a crawler fetches each
            const page = await listSitemapShardDecisionsHandler(file, readDb);
            measuredQueries = undefined;
            if (!("items" in page)) {
              panic(
                `Expected ${file.year}/${file.month}/${file.bucket} to be served`,
              );
            }
            statementsPerFile.add(statements.length);
            expect(page.items.length).toBeLessThanOrEqual(SITEMAP_RANGE_ROWS);
            for (const item of page.items) {
              expect(item.updatedAt.toISOString()).toBe(stored.get(item.id));
            }
            const newest = Math.max(
              ...page.items.map(({ updatedAt }) => updatedAt.getTime()),
            );
            expect(file.lastmod).toBe(dayOf(new Date(newest)));
            expect(newest).toBeLessThanOrEqual(NEWEST_UPDATE.getTime());
            served.push(...page.items.map(({ id }) => id));
          }
          // A file of a dozen-range month reads as many statements as the
          // quiet month's one file.
          expect(statementsPerFile.size).toBe(1);
          expect(served).toHaveLength(SEEDED);
          expect(served.toSorted(compareCodeUnit)).toEqual(
            [...stored.keys()].toSorted(compareCodeUnit),
          );
          // Only the ranges holding a month's newest decision carry its date.
          expect(
            largeFiles.filter(
              ({ lastmod }) => lastmod === dayOf(NEWEST_UPDATE),
            ),
          ).toHaveLength(1);
          expect(
            (
              await isolated
                .select({ bucket: caseLawSitemapShards.bucket })
                .from(caseLawSitemapShards)
                .where(eq(caseLawSitemapShards.year, "2026"))
            ).every(({ bucket }) => bucket !== SITEMAP_ALL_BUCKET),
          ).toBe(true);
        } finally {
          measuredQueries = undefined;
          await isolated.execute(
            sql`DROP VIEW IF EXISTS pg_temp.case_law_published_decisions`,
          );
          await isolated.execute(sql`SET search_path TO public`);
          await isolated.execute(sql`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    }, 300_000);
  });
}
