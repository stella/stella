import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawPublishedDecisionsFixtureSql } from "@/api/tests/helpers/case-law-publication-view-fixture";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];

describe.skipIf(!enabled)("sitemap visibility drain (postgres)", () => {
  // timeout: exercises committed ticks around a deliberately open transaction.
  test("a pinned xmin pauses recounts and candidate reads until visibility advances", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required for sitemap visibility proof");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const sent: string[] = [];
      const { db } = openClient({
        max: 1,
        logger: {
          logQuery: (query) => {
            sent.push(query);
          },
        },
      });
      const { db: writerDb } = openClient({ max: 1 });
      const schema = sql.identifier(
        `sitemap_visibility_${Bun.randomUUIDv7().replaceAll("-", "")}`,
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
        await writerDb.execute(sql`SET search_path TO ${schema}, public`);
        await db.execute(caseLawPublishedDecisionsFixtureSql);
        await db.execute(sql`
          INSERT INTO case_law_sources (id, adapter_key, name, enabled)
          VALUES ('00000000-0000-4000-8000-000000000001', 'sitemap-visibility-fixture', 'Sitemap visibility fixture', false)
        `);
        await db.execute(sql`
          INSERT INTO case_law_decisions
            (id, source_id, source_document_id, country, language, court, case_number, decision_date, metadata, updated_at)
          VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
            'visibility', 'XVP', 'xx', 'Fixture court', 'visibility', '1900-01-01', '{}'::jsonb, '2020-01-01'::timestamptz)
        `);
        const opened = Promise.withResolvers<string>();
        const release = Promise.withResolvers<undefined>();
        const writing = writerDb.transaction(async (tx) => {
          const row = executedRows(
            await tx.execute(sql`
            INSERT INTO case_law_sitemap_changes (country, year, month)
            VALUES ('XVP', '1900', '01') RETURNING id::text AS change_id
          `),
          ).at(0);
          if (!isRecord(row) || typeof row["change_id"] !== "string") {
            panic("Missing reserved change ID");
          }
          await tx.execute(
            sql`UPDATE case_law_decisions SET updated_at = '2030-01-01'::timestamptz WHERE country = 'XVP'`,
          );
          opened.resolve(row["change_id"]);
          await release.promise;
        });
        const reservedId = await opened.promise;
        try {
          const committed = executedRows(
            await db.execute(sql`
            INSERT INTO case_law_sitemap_changes (country, year, month)
            VALUES ('XVP', '1900', '01') RETURNING id::text AS change_id
          `),
          ).at(0);
          if (
            !isRecord(committed) ||
            typeof committed["change_id"] !== "string"
          ) {
            panic("Missing committed change ID");
          }
          expect(BigInt(reservedId)).toBeLessThan(
            BigInt(committed["change_id"]),
          );
          expect(
            await refreshCaseLawSitemapShards(db, { changeRowBudget: 20 }),
          ).toMatchObject({ months: 1 });
          const firstSnapshot = executedRows(
            await db.execute(sql`
            SELECT last_modified_at::text AS last_modified FROM case_law_sitemap_shards
            WHERE country = 'XVP' AND year = '1900' AND month = '01'
          `),
          ).at(0);
          expect(
            isRecord(firstSnapshot)
              ? firstSnapshot["last_modified"]
              : undefined,
          ).toMatch(/^2020-01-01/u);
          for (let tick = 0; tick < 5; tick += 1) {
            sent.length = 0;
            // db-await-in-loop: repeated committed ticks must remain idle while the same xmin is pinned.
            expect(
              await refreshCaseLawSitemapShards(db, { changeRowBudget: 20 }),
            ).toMatchObject({ type: "pending", months: 0, retry: "delayed" });
            expect(sent.some((query) => query.includes("WITH counts AS"))).toBe(
              false,
            );
            expect(
              sent.some((query) =>
                query.includes("WITH RECURSIVE candidates AS"),
              ),
            ).toBe(false);
          }
          const queued = executedRows(
            await db.execute(
              sql`SELECT count(*)::int AS total FROM case_law_sitemap_changes`,
            ),
          ).at(0);
          expect(isRecord(queued) ? queued["total"] : undefined).toBe(1);
        } finally {
          release.resolve(undefined);
          await writing;
        }
        // Releasing the oldest transaction makes both commits safe on the next tick.
        expect(
          await refreshCaseLawSitemapShards(db, { changeRowBudget: 20 }),
        ).toMatchObject({ type: "refreshed", months: 1 });
        const remaining = executedRows(
          await db.execute(
            sql`SELECT count(*)::int AS total FROM case_law_sitemap_changes`,
          ),
        ).at(0);
        expect(isRecord(remaining) ? remaining["total"] : undefined).toBe(0);
        const updated = executedRows(
          await db.execute(sql`
          SELECT last_modified_at::text AS last_modified FROM case_law_sitemap_shards
          WHERE country = 'XVP' AND year = '1900' AND month = '01'
        `),
        ).at(0);
        expect(
          isRecord(updated) ? updated["last_modified"] : undefined,
        ).toMatch(/^2030-01-01/u);
      } finally {
        await db.execute(
          sql`DROP VIEW IF EXISTS pg_temp.case_law_published_decisions`,
        );
        await db.execute(sql`SET search_path TO public`);
        await writerDb.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 30_000);
});
