import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  refreshCaseLawSitemapShards,
  sitemapPendingMonthsSql,
} from "@/api/lib/case-law/sitemap-shard-refresh";
import { tryLockCaseLawSitemapMonth } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawPublishedDecisionsFixtureSql } from "@/api/tests/helpers/case-law-publication-view-fixture";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
const HOT_MONTH_ROWS = 200_000;
const CHANGE_ROW_BUDGET = 20;

const discoveryScans = (
  value: unknown,
  limit: number | undefined = undefined,
): number => {
  if (!isRecord(value)) {
    panic("Invalid discovery plan node");
  }
  const nodeType = value["Node Type"];
  // A sort before the index scan defeats the one-row descent even when its output is capped.
  let nextLimit: unknown = limit;
  if (nodeType === "Limit") {
    nextLimit = value["Plan Rows"];
  } else if (nodeType === "Sort") {
    nextLimit = undefined;
  }
  let scans = 0;
  if (
    value["Relation Name"] === "case_law_sitemap_changes" ||
    value["Relation Name"] === "case_law_sitemap_drain_progress"
  ) {
    expect(value["Node Type"]).toMatch(/^Index(?: Only)? Scan$/u);
    expect(value["Scan Direction"]).toBe("Forward");
    if (value["Alias"] === "progress") {
      // Status checks use the unique target key rather than another ordered page.
      expect(value["Index Cond"]).toMatch(/country.*=.*year.*=.*month.*=/u);
    } else {
      expect(nextLimit).toBe(1);
    }
    expect(value["Actual Rows"]).toBeLessThanOrEqual(1);
    scans += 1;
  }
  const children = value["Plans"];
  if (Array.isArray(children)) {
    for (const child of children) {
      scans += discoveryScans(
        child,
        typeof nextLimit === "number" ? nextLimit : undefined,
      );
    }
  }
  return scans;
};

describe.skipIf(!enabled)("sitemap discovery fairness (postgres)", () => {
  // timeout: exercises indexed discovery over a large queue and committed ticks while another transaction holds a month.
  test("rotation skips hot, pinned and held months and cleans progress without change rows", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required for sitemap fairness proof");
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
      const { db: holder } = openClient({ max: 1 });
      const schema = sql.identifier(
        `sitemap_fairness_${Bun.randomUUIDv7().replaceAll("-", "")}`,
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
        await holder.execute(sql`SET search_path TO ${schema}, public`);
        await db.execute(caseLawPublishedDecisionsFixtureSql);
        await db.execute(sql`
          INSERT INTO case_law_sources (id, adapter_key, name, enabled)
          VALUES ('00000000-0000-4000-8000-000000000001', 'sitemap-fairness-fixture', 'Sitemap fairness fixture', false)
        `);
        await db.execute(sql`
          INSERT INTO case_law_decisions
            (id, source_id, source_document_id, country, language, court, case_number, decision_date, metadata)
          SELECT md5('sitemap-fairness-' || country)::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            country, country, 'xx', 'Fixture court', country, '1900-01-01'::date, '{}'::jsonb
          FROM (VALUES ('XAA'), ('XBB'), ('XBC'), ('XBD')) AS fixture(country)
        `);
        await db.execute(sql`
          INSERT INTO case_law_sitemap_changes (country, year, month, xact)
          SELECT 'XAA', '1900', '01', n::text::xid8 FROM generate_series(1, ${HOT_MONTH_ROWS}) AS n
        `);
        await db.execute(sql`ANALYZE case_law_sitemap_changes`);
        await db.execute(sql`
          INSERT INTO case_law_sitemap_drain_progress (country, year, month, covered_before)
          VALUES ('XAA', '1900', '01', '1'::xid8)
        `);
        await db.execute(sql`
          INSERT INTO case_law_sitemap_changes (country, year, month) VALUES ('XBB', '1900', '01')
        `);
        for (const after of [
          { country: "", year: "", month: "" },
          { country: "XAA", year: "1900", month: "01" },
          { country: "ZZZ", year: "9999", month: "12" },
        ]) {
          // db-await-in-loop: three fixed cursor positions prove the next and wrap paths over the same large queue.
          const result = await db.execute(
            sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sitemapPendingMonthsSql(after)}`,
          );
          const row = executedRows(result).at(0);
          const documents = isRecord(row) ? row["QUERY PLAN"] : undefined;
          const document = Array.isArray(documents)
            ? documents.at(0)
            : undefined;
          if (!isRecord(document)) {
            panic("Missing discovery EXPLAIN document");
          }
          console.log(
            "SITEMAP_DISCOVERY_PLAN_EVIDENCE",
            JSON.stringify({ after, rows: HOT_MONTH_ROWS, document }),
          );
          expect(discoveryScans(document["Plan"])).toBeGreaterThanOrEqual(2);
          const selected = executedRows(
            await db.execute(sitemapPendingMonthsSql(after)),
          ).at(0);
          expect(isRecord(selected) ? selected["country"] : undefined).toBe(
            after.country === "XAA" ? "XBB" : "XAA",
          );
        }
        let clockMs = 0;
        const advancingClock = () => {
          clockMs += 1;
          return clockMs;
        };
        for (let tick = 0; tick < 2; tick += 1) {
          // db-await-in-loop: a fresh month must publish within two bounded ticks despite the perpetually uncovered hot month.
          await db.execute(sql`
            INSERT INTO case_law_sitemap_changes (country, year, month, xact)
            VALUES ('XAA', '1900', '01', ${String(HOT_MONTH_ROWS + tick + 1)}::xid8)
          `);
          sent.length = 0;
          await refreshCaseLawSitemapShards(db, {
            changeRowBudget: CHANGE_ROW_BUDGET,
            runBudgetMs: 0,
            clock: advancingClock,
          });
          expect(
            sent.filter((query) => query.includes("next_change AS")).length,
          ).toBeLessThanOrEqual(64);
        }
        expect(
          executedRows(
            await db.execute(
              sql`SELECT total FROM case_law_sitemap_shards WHERE country = 'XBB'`,
            ),
          ),
        ).toEqual([{ total: 1 }]);
        const pinned = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const holding = holder.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_current_xact_id()`);
          pinned.resolve(undefined);
          await release.promise;
        });
        await pinned.promise;
        try {
          await db.execute(sql`
            UPDATE case_law_sitemap_drain_progress SET phase = 'awaiting_visibility',
              covered_before = pg_snapshot_xmin(pg_current_snapshot()) WHERE country = 'XAA'
          `);
          await db.execute(sql`DELETE FROM case_law_sitemap_refresh_cursor`);
          await db.execute(
            sql`INSERT INTO case_law_sitemap_changes (country, year, month) VALUES ('XBC', '1900', '01')`,
          );
          await refreshCaseLawSitemapShards(db, {
            changeRowBudget: CHANGE_ROW_BUDGET,
          });
          expect(
            executedRows(
              await db.execute(
                sql`SELECT total FROM case_law_sitemap_shards WHERE country = 'XBC'`,
              ),
            ),
          ).toEqual([{ total: 1 }]);
        } finally {
          release.resolve(undefined);
          await holding;
        }
        const locked = Promise.withResolvers<undefined>();
        const unlock = Promise.withResolvers<undefined>();
        const locking = holder.transaction(async (tx) => {
          expect(
            await tryLockCaseLawSitemapMonth({
              tx,
              month: { country: "XAA", year: "1900", month: "01" },
            }),
          ).toBe(true);
          locked.resolve(undefined);
          await unlock.promise;
        });
        await locked.promise;
        try {
          await db.execute(
            sql`UPDATE case_law_sitemap_drain_progress SET phase = 'draining' WHERE country = 'XAA'`,
          );
          await db.execute(sql`DELETE FROM case_law_sitemap_refresh_cursor`);
          await db.execute(
            sql`INSERT INTO case_law_sitemap_changes (country, year, month) VALUES ('XBD', '1900', '01')`,
          );
          await refreshCaseLawSitemapShards(db, {
            changeRowBudget: CHANGE_ROW_BUDGET,
          });
          expect(
            executedRows(
              await db.execute(
                sql`SELECT total FROM case_law_sitemap_shards WHERE country = 'XBD'`,
              ),
            ),
          ).toEqual([{ total: 1 }]);
        } finally {
          unlock.resolve(undefined);
          await locking;
        }
        await db.execute(sql`DELETE FROM case_law_sitemap_changes`);
        await db.execute(sql`DELETE FROM case_law_sitemap_drain_progress`);
        await db.execute(sql`
          INSERT INTO case_law_sitemap_drain_progress (country, year, month, covered_before)
          VALUES ('XZZ', '1900', '01', '1'::xid8)
        `);
        await db.execute(sql`DELETE FROM case_law_sitemap_refresh_cursor`);
        sent.length = 0;
        expect(
          await refreshCaseLawSitemapShards(db, {
            changeRowBudget: CHANGE_ROW_BUDGET,
          }),
        ).toMatchObject({ type: "refreshed", months: 0 });
        expect(
          executedRows(
            await db.execute(
              sql`SELECT country FROM case_law_sitemap_drain_progress`,
            ),
          ),
        ).toEqual([]);
        expect(sent.some((query) => query.includes("WITH counts AS"))).toBe(
          false,
        );
      } finally {
        await holder.execute(sql`RESET search_path`);
        await db.execute(sql`RESET search_path`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 90_000);
});
