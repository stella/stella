import { panic } from "better-result";
import type { SQL as BunSql } from "bun";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import { defaultConfig, initialBatchState } from "@stll/db-load-gate/health";

import {
  caseLawDecisions,
  caseLawSitemapChanges,
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
import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import {
  decisionBucketSqlFor,
  SITEMAP_ALL_BUCKET,
} from "@/api/lib/case-law/sitemap-shard-sql";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawPublishedDecisionsFixtureSql } from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { CASE_LAW_SITEMAP_PACKING_ENROLLMENT } from "./case-law-sitemap-packing-enrollment";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import {
  ONLINE_MIGRATION_REPAIRS,
  runOnlineMigrations,
} from "./online-migrations";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
type RefreshDb = Parameters<typeof refreshCaseLawSitemapShards>[0];

if (!databaseUrl || !enabled) {
  describe.skip("sitemap packing enrollment (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(enabled && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("sitemap packing enrollment (postgres)", () => {
    // timeout: seeds and reads a full protocol-sized sitemap through real PostgreSQL.
    test("monolingual months pack 50000 URLs with flat reads, cached bucket partitions and lastmod", async () => {
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
        const schemaName = `sitemap_capacity_${Bun.randomUUIDv7().replaceAll("-", "")}`;
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

          const capacitySourceId = createSafeId<"caseLawSource">();
          await isolated.insert(caseLawSources).values({
            id: capacitySourceId,
            adapterKey: "sitemap-capacity-fixture",
            name: "Sitemap capacity fixture",
            enabled: false,
          });
          const newest = new Date("2024-07-02T09:30:00Z");
          await isolated.execute(sql`
            INSERT INTO case_law_decisions
              (id, source_id, case_number, court, country, language, language_group_key, decision_date, updated_at)
            SELECT md5('sitemap-capacity-' || i::text)::uuid, ${capacitySourceId}::uuid,
              'sitemap-capacity-' || i::text, 'Fixture court', 'CZE', 'cs', 'sitemap-capacity-' || i::text,
              CASE WHEN i < 5000 THEN '2024-06-15'::date ELSE '2026-06-15'::date END,
              CASE WHEN i = 0 OR i = 5000 THEN ${newest.toISOString()}::timestamptz ELSE '2024-07-01'::timestamptz END
            FROM generate_series(0, 55000) AS i
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
          // Quiet legacy packing has no pending invalidation; only the larger
          // new month is enrolled before the packing migration runs.
          await isolated.execute(sql`
            INSERT INTO case_law_sitemap_shards (country, year, month, bucket, total, last_modified_at)
            SELECT 'CZE', '2024', '06', ${decisionBucketSqlFor(caseLawDecisions)}, count(*)::int, max(updated_at)
            FROM case_law_decisions WHERE decision_date = '2024-06-15'::date GROUP BY 4
          `);
          await isolated
            .insert(caseLawSitemapChanges)
            .values({ country: "CZE", year: "2026", month: "06" });
          await refreshCaseLawSitemapShards(isolatedRefresh);
          const listed = await listSitemapShardsHandler(readDb);
          if (!("items" in listed)) {
            panic("Expected fixture sitemap index");
          }
          expect(
            listed.items.filter(({ year }) => year === "2026"),
          ).toHaveLength(64);
          const query = {
            country: "cze",
            year: "2026",
            month: "06",
            bucket: SITEMAP_ALL_BUCKET,
          };
          expect(
            await listSitemapShardDecisionsHandler(query, readDb),
          ).toMatchObject({ code: 500 });
          await isolated.execute(
            sql`DELETE FROM case_law_decisions WHERE case_number = 'sitemap-capacity-5001'`,
          );
          await isolated
            .insert(caseLawSitemapChanges)
            .values({ country: "CZE", year: "2026", month: "06" });
          await refreshCaseLawSitemapShards(isolatedRefresh);
          const packed = await listSitemapShardsHandler(readDb);
          if (!("items" in packed)) {
            panic("Expected consolidated fixture sitemap index");
          }
          expect(
            packed.items.filter(({ year }) => year === "2026"),
          ).toMatchObject([
            {
              bucket: SITEMAP_ALL_BUCKET,
              lastmod: newest.toISOString().slice(0, 10),
            },
          ]);
          const quietBefore = packed.items.filter(
            ({ year }) => year === "2024",
          );
          expect(quietBefore).toHaveLength(64);
          const quietBucketQuery = { ...query, year: "2024", bucket: "00" };
          const quietBucketBefore = await listSitemapShardDecisionsHandler(
            quietBucketQuery,
            readDb,
          );
          if (!("items" in quietBucketBefore)) {
            panic("Expected cached quiet bucket before enrollment");
          }
          await isolated.execute(sql`
            INSERT INTO case_law_sitemap_shards (country, year, month, bucket, total, last_modified_at)
            SELECT 'X' || chr(65 + (i / 26)::int) || chr(65 + (i % 26)::int),
              '1800', '01', lpad(bucket::text, 2, '0'), 1, ${newest.toISOString()}::timestamptz
            FROM generate_series(0, 99) AS i CROSS JOIN generate_series(0, 63) AS bucket
          `);
          await isolated.execute(sql`
            INSERT INTO case_law_decisions (id, source_id, case_number, country, court, language, decision_date)
            VALUES (${createSafeId<"caseLawDecision">()}::uuid, ${capacitySourceId}::uuid, 'no-snapshot-fixture', 'XNS', 'Fixture court', 'xx', '1888-01-01'::date)
          `);
          await isolated.execute(sql`ANALYZE case_law_sitemap_shards`);
          await isolated
            .insert(caseLawSitemapChanges)
            .values({ country: "XAA", year: "*", month: "*" });
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
                  (repair) => repair === CASE_LAW_SITEMAP_PACKING_ENROLLMENT,
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
                CASE_LAW_SITEMAP_PACKING_ENROLLMENT.name,
              ),
            );
          expect(await enroll()).toEqual({ type: "complete" });
          const pendingEnrollment = await isolated
            .select()
            .from(caseLawSitemapChanges)
            .where(sql`year = '*' AND month = '*'`);
          const tickOptions = {
            changeRowBudget: 10_000,
            discoveryTargetBudget: 64,
          };
          // Each enrolled country contributes its broad target and at most two fixture months.
          const maxDrainTicks =
            Math.ceil(
              (2 * pendingEnrollment.length + 2) /
                tickOptions.discoveryTargetBudget,
            ) + 1;
          let drained = await refreshCaseLawSitemapShards(
            isolatedRefresh,
            tickOptions,
          );
          for (
            let tick = 1;
            drained.type === "pending" && tick < maxDrainTicks;
            tick += 1
          ) {
            drained = await refreshCaseLawSitemapShards(
              isolatedRefresh,
              tickOptions,
            );
          }
          expect(drained.type).toBe("refreshed");
          const repacked = await listSitemapShardsHandler(readDb);
          if (!("items" in repacked)) {
            panic("Expected repacked quiet month");
          }
          expect(
            repacked.items.filter(({ year }) => year === "2024"),
          ).toHaveLength(1);
          expect(
            repacked.items.filter(({ year }) => year === "2024"),
          ).toMatchObject([
            {
              bucket: SITEMAP_ALL_BUCKET,
              lastmod: newest.toISOString().slice(0, 10),
            },
          ]);
          expect(checkpoint?.cursor).toBe("complete");
          expect(checkpoint?.batch).toEqual(initialBatchState(defaultConfig));

          expect(pendingEnrollment).toHaveLength(101);
          expect(
            pendingEnrollment.some(({ country }) => country === "XNS"),
          ).toBe(false);
          expect(pageSizes).toEqual([100, 1]);
          expect(
            await isolated.select().from(caseLawSitemapChanges),
          ).toHaveLength(0);
          repairQueries.length = 0;
          expect(await enroll()).toEqual({ type: "complete" });
          expect(
            await isolated.select().from(caseLawSitemapChanges),
          ).toHaveLength(0);
          const completionQueries = repairQueries.filter(
            (statement) =>
              statement.includes("public.database_backfill_states") ||
              statement.includes("public.case_law_sitemap_changes") ||
              statement.includes("public.case_law_sitemap_shards"),
          );
          expect(completionQueries).toHaveLength(1);
          expect(completionQueries.at(0)).toContain("WHERE name = $1 LIMIT 1");
          const quietBucketAfter = await listSitemapShardDecisionsHandler(
            quietBucketQuery,
            readDb,
          );
          expect(quietBucketAfter).toEqual(quietBucketBefore);
          const smallerQueries: string[] = [];
          measuredQueries = smallerQueries;
          const smaller = await listSitemapShardDecisionsHandler(
            { ...query, year: "2024" },
            readDb,
          );
          measuredQueries = undefined;
          if (!("items" in smaller)) {
            panic("Expected the smaller measurement fixture");
          }
          expect(smaller.items).toHaveLength(5000);
          const largerQueries: string[] = [];
          measuredQueries = largerQueries;
          const full = await listSitemapShardDecisionsHandler(query, readDb);
          measuredQueries = undefined;
          if (!("items" in full)) {
            panic(
              "Expected a complete monolingual month at the protocol ceiling",
            );
          }
          expect(full.items).toHaveLength(50_000);
          expect(largerQueries).toHaveLength(smallerQueries.length);
          expect(
            full.items.find(
              ({ caseNumber }) => caseNumber === "sitemap-capacity-5000",
            )?.updatedAt,
          ).toEqual(newest);
          const cached = await listSitemapShardDecisionsHandler(
            { ...query, bucket: "00" },
            readDb,
          );
          if (!("items" in cached)) {
            panic("Expected cached bucket URL to remain readable");
          }
          const expected = await isolated
            .select({ id: caseLawDecisions.id })
            .from(caseLawDecisions)
            .where(
              sql`${caseLawDecisions.decisionDate} = '2026-06-15'::date AND ${decisionBucketSqlFor(caseLawDecisions)} = '00'`,
            );
          expect(cached.items.length).toBeGreaterThan(0);
          expect(cached.items.length).toBe(expected.length);
          expect(
            cached.items.map(({ id }) => id).toSorted(compareCodeUnit),
          ).toEqual(expected.map(({ id }) => id).toSorted(compareCodeUnit));
        } finally {
          measuredQueries = undefined;
          await isolated.execute(
            sql`DROP VIEW IF EXISTS pg_temp.case_law_published_decisions`,
          );
          await isolated.execute(sql`SET search_path TO public`);
          await isolated.execute(sql`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    }, 120_000);
  });
}
