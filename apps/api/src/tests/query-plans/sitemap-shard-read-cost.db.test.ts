import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { and, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getTableConfig, getViewConfig, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import {
  SITEMAP_FILE_FETCH_TIMEOUT_MS,
  SITEMAP_FILE_SERVE_TARGET_MS,
} from "@stll/api-contract/public-sitemap-budget";

import {
  SITEMAP_LANGUAGE_GROUP_INDEX,
  SITEMAP_MONTH_INDEX,
  SITEMAP_RANGE_INDEX,
} from "@/api/db/case-law-sitemap-indexes";
import {
  caseLawDecisions,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import {
  getShardConditions,
  sitemapShardDecisionsQuery,
} from "@/api/handlers/case-law/decisions/sitemap";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  SITEMAP_RANGE_ROWS,
  SITEMAP_RANGE_ROWS_CEILING,
  SITEMAP_SHARD_READ_DEADLINE_MS,
  SITEMAP_SHARD_READ_PAGES_PER_ROW,
  sitemapShardReadCostMs,
} from "@/api/lib/case-law/sitemap-shard-budget";
import { sitemapMonthCountSql } from "@/api/lib/case-law/sitemap-shard-refresh";
import type { SitemapRange } from "@/api/lib/case-law/sitemap-shard-sql";
import {
  SITEMAP_RANGES_PER_MONTH_MAX,
  sitemapDocumentRepresentativeFor,
} from "@/api/lib/case-law/sitemap-shard-sql";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";
import { vacuumUntilAllVisible } from "@/api/tests/query-plans/visibility";

/**
 * What one case-law sitemap file costs to read, measured on rows shaped like
 * production's: wide heap rows, a month's decisions spread over the heap among
 * other months', one decision in ten a translation. The budget in
 * `case-law/sitemap-shard-budget.ts` assumes a page count per decision read;
 * this measures it, and that a file's cost does not grow with its month.
 */

const COUNTRY = "CZE";
const SOURCE_ID = "00000000-0000-7000-8000-000000000001";
/** A month a few ranges long, and one several times larger. */
const SMALL_MONTH = { country: COUNTRY, year: "2020", month: "03" } as const;
const LARGE_MONTH = { country: COUNTRY, year: "2020", month: "04" } as const;
const SMALL_MONTH_ROWS = 3 * SITEMAP_RANGE_ROWS + 123;
const LARGE_MONTH_ROWS = 9 * SITEMAP_RANGE_ROWS + 45;
const OTHER_ROWS = 20_000;
/** Inline row width: case-law rows carry wide metadata beside the text. */
const ROW_PADDING_BYTES = 1200;

type PlanNode = Record<string, unknown>;

const numberField = (node: PlanNode, field: string): number => {
  const value = node[field] ?? 0;
  return typeof value === "number"
    ? value
    : panic(`Plan field ${field} is not a number`);
};

/** Shared pages the whole statement visited, its children included. */
const pagesVisited = (root: PlanNode): number =>
  numberField(root, "Shared Hit Blocks") +
  numberField(root, "Shared Read Blocks");

const rangeRowSchema = (raw: unknown): SitemapRange => {
  if (!isRecord(raw)) {
    return panic("Unexpected month count row");
  }
  const bound = (date: unknown, id: unknown) =>
    typeof date === "string" && typeof id === "string" ? { date, id } : null;
  return {
    start: bound(raw["start_date"], raw["start_id"]),
    end: bound(raw["end_date"], raw["end_id"]),
  };
};

test("the sitemap budget's cut, ceiling and deadline fit inside the web server's wait", () => {
  // A cut range's cold read fits the serve target with room for the rest of
  // the request; one grown to the ceiling still ends before the deadline,
  // which ends before the web server stops waiting.
  expect(sitemapShardReadCostMs(SITEMAP_RANGE_ROWS)).toBeLessThanOrEqual(
    SITEMAP_FILE_SERVE_TARGET_MS - 1000,
  );
  expect(sitemapShardReadCostMs(SITEMAP_RANGE_ROWS_CEILING)).toBeLessThan(
    SITEMAP_SHARD_READ_DEADLINE_MS,
  );
  expect(SITEMAP_SHARD_READ_DEADLINE_MS).toBeLessThan(
    SITEMAP_FILE_FETCH_TIMEOUT_MS,
  );
  // A file never lists more than the protocol allows.
  expect(LIMITS.caseLawSitemapShardUrlLimit).toBe(SITEMAP_RANGE_ROWS_CEILING);
  expect(SITEMAP_RANGE_ROWS_CEILING).toBeLessThan(
    LIMITS.caseLawSitemapUrlLimit,
  );
  // One index lists every range of a corpus of fifty million decisions with
  // a partly filled range in each of a thousand months per country across
  // twenty countries; one month holds up to its names' worth of ranges.
  const months = 1000 * 20;
  const ranges = Math.ceil(50_000_000 / SITEMAP_RANGE_ROWS) + months;
  expect(ranges).toBeLessThan(LIMITS.caseLawSitemapIndexEntryLimit);
  expect(SITEMAP_RANGES_PER_MONTH_MAX * SITEMAP_RANGE_ROWS).toBeGreaterThan(
    10_000_000,
  );
});

// timeout: an embedded Postgres seeds about 40,000 wide rows, builds three indexes and plans each range.
test("a sitemap file reads a bounded number of pages per decision, whatever its month holds", async () => {
  const client = new PGlite();
  try {
    for (const table of [caseLawSources, caseLawDecisions]) {
      const { columns, name } = getTableConfig(table);
      const declared = columns.map(
        (column) => `"${column.name}" ${column.getSQLType()}`,
      );
      await client.exec(`CREATE TABLE ${name} (${declared.join(", ")})`);
    }
    const db = drizzle({ client });
    const view = getViewConfig(publishedCaseLawDecisions);
    await db.execute(
      sql`CREATE VIEW ${sql.identifier(view.name)} AS (${sql.raw(
        new PgDialect().sqlToQuery(
          view.query ?? panic("Declared view must include a query"),
        ).sql,
      )})`,
    );
    await db.execute(sql`
      INSERT INTO case_law_sources (id, adapter_key, name)
      VALUES (${SOURCE_ID}::uuid, 'sitemap-cost', 'Sitemap cost fixture')
    `);
    // Rows arrive interleaved across months, as a corpus is ingested over
    // years, so a month's rows sit on many heap pages. The padding does not
    // compress, so each row keeps its width.
    const total = SMALL_MONTH_ROWS + LARGE_MONTH_ROWS + OTHER_ROWS;
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, case_number, slug, court, country, language, language_group_key,
         decision_date, updated_at, metadata)
      SELECT
        gen_random_uuid(),
        ${SOURCE_ID}::uuid,
        n || ' Cdo ' || n || '/2020',
        'decision-' || n,
        'Nejvyšší soud',
        ${COUNTRY},
        CASE WHEN n % 10 = 0 THEN 'en' ELSE 'cs' END,
        'group-' || CASE WHEN n % 10 = 0 THEN n - 1 ELSE n END,
        CASE
          WHEN n % 4 = 1 AND n / 4 < ${SMALL_MONTH_ROWS} THEN DATE '2020-03-01' + (n % 28)
          WHEN n % 4 IN (2, 3) AND n / 2 < ${LARGE_MONTH_ROWS} THEN DATE '2020-04-01' + (n % 28)
          ELSE DATE '2010-01-01' + (n % 3000)
        END,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + n * INTERVAL '1 second',
        jsonb_build_object('padding', (
          SELECT string_agg(md5(n::text || part::text), '')
          FROM generate_series(1, ${Math.ceil(ROW_PADDING_BYTES / 32)}) AS part
        ))
      FROM generate_series(1, ${total}) AS n
    `);
    await client.exec(`
      ALTER TABLE case_law_sources ADD PRIMARY KEY (id);
      ALTER TABLE case_law_decisions ADD PRIMARY KEY (id);
    `);
    for (const { createSql } of [
      SITEMAP_MONTH_INDEX,
      SITEMAP_LANGUAGE_GROUP_INDEX,
      SITEMAP_RANGE_INDEX,
    ]) {
      await client.exec(
        createSql.replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX"),
      );
    }
    await vacuumUntilAllVisible({ db, table: "case_law_decisions" });
    await vacuumUntilAllVisible({ db, table: "case_law_sources" });

    const explain = async (statement: SQL): Promise<PlanNode> => {
      const { sql: text, params } = new PgDialect().sqlToQuery(statement);
      const { rows } = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
        params,
      );
      return explainRoot({ rows });
    };
    const monthRanges = async (
      month: typeof SMALL_MONTH | typeof LARGE_MONTH,
      monthRows: number,
    ) => {
      const { rows } = await client.query(
        new PgDialect().sqlToQuery(sitemapMonthCountSql(month)).sql,
        new PgDialect().sqlToQuery(sitemapMonthCountSql(month)).params,
      );
      const ranges = rows.map(rangeRowSchema);
      // Every range but the last is a full cut; the last holds the rest.
      expect(ranges).toHaveLength(Math.ceil(monthRows / SITEMAP_RANGE_ROWS));
      return ranges;
    };
    /** Pages one range's read visits, and the decisions it scanned. */
    const readRange = async (
      month: typeof SMALL_MONTH | typeof LARGE_MONTH,
      range: SitemapRange,
    ) => {
      const conditions = getShardConditions(month);
      if (!Array.isArray(conditions)) {
        return panic("The cost fixture's month must be valid");
      }
      const statement = sitemapShardDecisionsQuery(
        asTestRaw<CaseLawPublicReadTransaction>(db),
        conditions,
        range,
      ).getSQL();
      const listed = await sitemapShardDecisionsQuery(
        asTestRaw<CaseLawPublicReadTransaction>(db),
        conditions,
        range,
      );
      return { pages: pagesVisited(await explain(statement)), listed };
    };

    const smallRanges = await monthRanges(SMALL_MONTH, SMALL_MONTH_ROWS);
    const largeRanges = await monthRanges(LARGE_MONTH, LARGE_MONTH_ROWS);
    // A full range from the middle of each month.
    const small = await readRange(
      SMALL_MONTH,
      smallRanges[1] ?? panic("Missing small range"),
    );
    const large = await readRange(
      LARGE_MONTH,
      largeRanges[4] ?? panic("Missing large range"),
    );
    const pagesPerRow = {
      small: small.pages / SITEMAP_RANGE_ROWS,
      large: large.pages / SITEMAP_RANGE_ROWS,
    };
    process.stdout.write(
      `Sitemap range read: ${String(small.pages)} pages for ${String(small.listed.length)} URLs of ${String(SITEMAP_RANGE_ROWS)} decisions in a ${String(SMALL_MONTH_ROWS)}-decision month; ${String(large.pages)} pages in a ${String(LARGE_MONTH_ROWS)}-decision month\n`,
    );
    expect(pagesPerRow.small).toBeLessThanOrEqual(
      SITEMAP_SHARD_READ_PAGES_PER_ROW,
    );
    expect(pagesPerRow.large).toBeLessThanOrEqual(
      SITEMAP_SHARD_READ_PAGES_PER_ROW,
    );
    // A month three times larger costs its files nothing more: a range reads
    // its own decisions and their probes, not the rest of its month.
    expect(Math.abs(large.pages - small.pages)).toBeLessThanOrEqual(
      small.pages * 0.1,
    );
    // Every range of both months together lists each month's documents once.
    for (const [month, ranges] of [
      [SMALL_MONTH, smallRanges],
      [LARGE_MONTH, largeRanges],
    ] as const) {
      const listed: string[] = [];
      for (const range of ranges) {
        // db-await-in-loop: one read per range, as a crawler fetches each file
        listed.push(
          ...(await readRange(month, range)).listed.map(({ id }) => id),
        );
      }
      expect(new Set(listed).size).toBe(listed.length);
      const conditions = getShardConditions(month);
      if (!Array.isArray(conditions)) {
        return panic("The cost fixture's month must be valid");
      }
      // Every listed document of the month, read whole and without a cut.
      // db-await-in-loop: one oracle read per fixture month, two in all
      const expected = await db
        .select({ id: publishedCaseLawDecisions.id })
        .from(publishedCaseLawDecisions)
        .where(
          and(
            ...conditions,
            sitemapDocumentRepresentativeFor(publishedCaseLawDecisions),
          ),
        );
      expect(expected.length).toBeGreaterThan(SITEMAP_RANGE_ROWS);
      expect(listed.toSorted()).toEqual(
        expected.map(({ id }) => id).toSorted(),
      );
    }
  } finally {
    await client.close();
  }
}, 600_000);
