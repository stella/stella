import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import type { rootDb } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSitemapShards,
  caseLawSources,
} from "@/api/db/schema";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  decisionBucketSql,
  decisionMonthSql,
  decisionYearSql,
  SITEMAP_ALL_BUCKET,
} from "@/api/lib/case-law/sitemap-shard-sql";
import { executedRows } from "@/api/lib/db/executed-rows";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/**
 * A month is split into buckets once it holds more than this many decisions.
 * The snapshot is as old as the last refresh while the shard read counts live
 * rows and refuses more than the URL limit, so splitting at half the limit
 * leaves a month room to grow between refreshes without its shard overflowing.
 */
export const SITEMAP_SHARD_SPLIT_THRESHOLD = Math.floor(
  LIMITS.caseLawSitemapShardUrlLimit / 2,
);

/**
 * Index entries one count statement reads. The count walks
 * `case_law_decisions_sitemap_shard_idx` in its own order, a page at a time,
 * so each statement's work is bounded by this and not by the corpus.
 */
export const SITEMAP_REFRESH_PAGE_SIZE = 20_000;

/** Rows per INSERT when the new snapshot is written. */
const SNAPSHOT_INSERT_CHUNK = 1000;

type TransactionBudget = { lockTimeout: string; statementTimeout: string };

/**
 * A page reads a bounded range of one index, so a statement that runs past
 * this is not making progress; it is cancelled and the next tick starts over.
 */
const PAGE_BUDGET: TransactionBudget = {
  lockTimeout: "5s",
  statementTimeout: "30s",
};

/**
 * The swap deletes and rewrites a table of at most one row per index entry of
 * the sitemap, in chunks; the lock wait covers an overlapping refresh's swap.
 */
const SWAP_BUDGET: TransactionBudget = {
  lockTimeout: "30s",
  statementTimeout: "30s",
};

type RefreshDb = Pick<typeof rootDb, "transaction">;
type RefreshTransaction = Parameters<
  Parameters<RefreshDb["transaction"]>[0]
>[0];

/**
 * Both budgets, set LOCAL so they end with the transaction. Written as raw
 * statements because `SET LOCAL` takes a literal, not a bind parameter; the
 * values are this module's own constants.
 */
const setTransactionBudget = async (
  tx: RefreshTransaction,
  { lockTimeout, statementTimeout }: TransactionBudget,
): Promise<void> => {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lockTimeout}'`));
  await tx.execute(
    sql.raw(`SET LOCAL statement_timeout = '${statementTimeout}'`),
  );
};

/**
 * Where a page stopped: the last index entry it read. Every field is the
 * database's own text for the value, bound back as that type, so the next page
 * resumes exactly after it (a timestamp through a JS Date would lose its
 * microseconds and skip or repeat entries).
 */
export type SitemapRefreshCursor = {
  decisionDate: string | null;
  id: string;
  sourceId: string;
  updatedAt: string;
};

/**
 * The index is ordered by (country, decision_date, source_id, updated_at, id)
 * with undated decisions after the dated ones. A row comparison cannot step
 * over a NULL date, so a country is walked in two phases: its dated entries,
 * then its undated ones, each resumed with a row comparison on the index's
 * own columns.
 */
export type SitemapRefreshPhase = "dated" | "undated";

const afterCursorSql = (
  phase: SitemapRefreshPhase,
  cursor: SitemapRefreshCursor | null,
): SQL => {
  if (phase === "dated") {
    const dated = sql`${caseLawDecisions.decisionDate} IS NOT NULL`;
    return cursor?.decisionDate
      ? sql`${dated} AND (${caseLawDecisions.decisionDate}, ${caseLawDecisions.sourceId}, ${caseLawDecisions.updatedAt}, ${caseLawDecisions.id}) > (${cursor.decisionDate}::date, ${cursor.sourceId}::uuid, ${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`
      : dated;
  }
  const undated = sql`${caseLawDecisions.decisionDate} IS NULL`;
  return cursor?.decisionDate === null
    ? sql`${undated} AND (${caseLawDecisions.sourceId}, ${caseLawDecisions.updatedAt}, ${caseLawDecisions.id}) > (${cursor.sourceId}::uuid, ${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`
    : undated;
};

/**
 * One page of the count: the next `pageSize` published decisions of a country
 * in index order, counted per month and bucket among the redistributable
 * sources, with the page's last entry as the cursor for the next one.
 *
 * Every column the page reads is on `case_law_decisions_sitemap_shard_idx` and
 * the publication gate is its partial predicate, so the page is an index-only
 * range read that stops at the limit. A page with no rows ends the phase; a
 * page whose rows are all withheld still returns its cursor, with no counts.
 * Exported for the plan test, which holds it to that index.
 */
export const sitemapRefreshPageSql = ({
  country,
  cursor,
  pageSize,
  phase,
}: {
  country: string;
  cursor: SitemapRefreshCursor | null;
  pageSize: number;
  phase: SitemapRefreshPhase;
}): SQL => sql`
  WITH page AS MATERIALIZED (
    SELECT
      ${caseLawDecisions.decisionDate} AS decision_date,
      ${caseLawDecisions.sourceId} AS source_id,
      ${caseLawDecisions.updatedAt} AS updated_at,
      ${caseLawDecisions.id} AS id,
      ${decisionYearSql} AS year,
      ${decisionMonthSql} AS month,
      ${decisionBucketSql} AS bucket
    FROM ${caseLawDecisions}
    WHERE ${publishedCaseLawDecision}
      AND ${caseLawDecisions.country} = ${country}
      AND ${afterCursorSql(phase, cursor)}
    ORDER BY
      ${caseLawDecisions.decisionDate},
      ${caseLawDecisions.sourceId},
      ${caseLawDecisions.updatedAt},
      ${caseLawDecisions.id}
    LIMIT ${pageSize}
  ),
  last_entry AS (
    SELECT decision_date, source_id, updated_at, id
    FROM page
    ORDER BY decision_date DESC, source_id DESC, updated_at DESC, id DESC
    LIMIT 1
  )
  SELECT
    last_entry.decision_date::text AS cursor_decision_date,
    last_entry.source_id::text AS cursor_source_id,
    last_entry.updated_at::text AS cursor_updated_at,
    last_entry.id::text AS cursor_id,
    counts.year,
    counts.month,
    counts.bucket,
    counts.total,
    counts.last_modified_ms
  FROM last_entry
  LEFT JOIN LATERAL (
    SELECT
      page.year,
      page.month,
      page.bucket,
      count(*)::int AS total,
      (extract(epoch FROM max(page.updated_at)) * 1000)::float8 AS last_modified_ms
    FROM page
    INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = page.source_id
    WHERE ${redistributableCaseLawSource}
    GROUP BY page.year, page.month, page.bucket
  ) AS counts ON true
`;

const pageRowSchema = v.object({
  bucket: v.nullable(v.string()),
  cursor_decision_date: v.nullable(v.string()),
  cursor_id: v.string(),
  cursor_source_id: v.string(),
  cursor_updated_at: v.string(),
  last_modified_ms: v.nullable(v.number()),
  month: v.nullable(v.string()),
  total: v.nullable(v.number()),
  year: v.nullable(v.string()),
});

type BucketCount = { lastModifiedMs: number; total: number };
type MonthCounts = Map<string, BucketCount>;
/** `country|year|month` to its buckets' counts. */
type CountryMonths = Map<string, MonthCounts>;

type PageOutcome = { cursor: SitemapRefreshCursor | null };

const readPage = async (
  db: RefreshDb,
  months: CountryMonths,
  page: Parameters<typeof sitemapRefreshPageSql>[0],
): Promise<PageOutcome> => {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await setTransactionBudget(tx, PAGE_BUDGET);
    return executedRows(await tx.execute(sitemapRefreshPageSql(page)));
  });
  let cursor: SitemapRefreshCursor | null = null;
  for (const raw of rows) {
    const row = v.parse(pageRowSchema, raw);
    cursor = {
      decisionDate: row.cursor_decision_date,
      id: row.cursor_id,
      sourceId: row.cursor_source_id,
      updatedAt: row.cursor_updated_at,
    };
    if (
      row.year === null ||
      row.month === null ||
      row.bucket === null ||
      row.total === null ||
      row.last_modified_ms === null
    ) {
      continue;
    }
    const monthKey = `${page.country}|${row.year}|${row.month}`;
    const buckets = months.get(monthKey) ?? new Map<string, BucketCount>();
    months.set(monthKey, buckets);
    const counted = buckets.get(row.bucket);
    buckets.set(row.bucket, {
      lastModifiedMs: Math.max(
        counted?.lastModifiedMs ?? row.last_modified_ms,
        row.last_modified_ms,
      ),
      total: (counted?.total ?? 0) + row.total,
    });
  }
  return { cursor };
};

type ShardRow = typeof caseLawSitemapShards.$inferInsert;

/**
 * A month becomes one `all` row, or one row per bucket once it passes the
 * split threshold.
 */
const shardRows = (months: CountryMonths): ShardRow[] =>
  [...months].flatMap(([monthKey, buckets]) => {
    const [country, year, month] = monthKey.split("|");
    if (country === undefined || year === undefined || month === undefined) {
      return panic(`Malformed sitemap month key ${monthKey}`);
    }
    let monthTotal = 0;
    let monthLastModifiedMs = 0;
    for (const count of buckets.values()) {
      monthTotal += count.total;
      monthLastModifiedMs = Math.max(monthLastModifiedMs, count.lastModifiedMs);
    }
    if (monthTotal > SITEMAP_SHARD_SPLIT_THRESHOLD) {
      return [...buckets].map(([bucket, count]) => ({
        bucket,
        country,
        lastModifiedAt: new Date(count.lastModifiedMs),
        month,
        total: count.total,
        year,
      }));
    }
    return [
      {
        bucket: SITEMAP_ALL_BUCKET,
        country,
        lastModifiedAt: new Date(monthLastModifiedMs),
        month,
        total: monthTotal,
        year,
      },
    ];
  });

/**
 * Replace the snapshot the public index reads in one transaction, so a reader
 * sees the previous snapshot or this one, never a mix. The table lock admits
 * readers and queues a second refresh's swap behind this one, so overlapping
 * refreshes each replace the snapshot whole rather than interleaving.
 */
const swapSnapshot = async (db: RefreshDb, rows: ShardRow[]): Promise<void> => {
  await db.transaction(async (tx) => {
    await setTransactionBudget(tx, SWAP_BUDGET);
    await tx.execute(
      sql`LOCK TABLE ${caseLawSitemapShards} IN SHARE ROW EXCLUSIVE MODE`,
    );
    await tx.delete(caseLawSitemapShards).where(sql`true`);
    for (let start = 0; start < rows.length; start += SNAPSHOT_INSERT_CHUNK) {
      // db-await-in-loop: bounded chunks of one snapshot, written in order inside its swap transaction
      await tx
        .insert(caseLawSitemapShards)
        .values(rows.slice(start, start + SNAPSHOT_INSERT_CHUNK));
    }
  });
};

/**
 * Recount the public sitemap shards and replace the snapshot the public index
 * reads.
 *
 * The count is a walk of the sitemap index in pages, each its own short,
 * read-only statement under its own timeout, so no statement's work grows
 * with the corpus. The counts accumulate here and are written in one swap at
 * the end: an aborted or failed walk leaves the previous snapshot in place.
 * Pages are separate snapshots, so a decision written during the walk may be
 * counted in either state; the snapshot is approximate by as much as it is
 * already stale between refreshes, which the split threshold leaves room for.
 *
 * The index read refuses a snapshot it cannot serve, so an over-capacity
 * count is logged here rather than withheld.
 */
export const refreshCaseLawSitemapShards = async (
  db: RefreshDb,
  {
    pageSize = SITEMAP_REFRESH_PAGE_SIZE,
    signal,
  }: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<{ largestShard: number; pages: number; shards: number }> => {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    return panic("Sitemap refresh page size must be a positive integer");
  }
  const months: CountryMonths = new Map();
  let pages = 0;
  for (const country of PUBLIC_CASE_LAW_COUNTRIES) {
    for (const phase of ["dated", "undated"] as const) {
      let cursor: SitemapRefreshCursor | null = null;
      do {
        if (signal?.aborted) {
          panic("SchedulerAborted");
        }
        // db-await-in-loop: each page resumes after the previous page's last index entry
        ({ cursor } = await readPage(db, months, {
          country,
          cursor,
          pageSize,
          phase,
        }));
        pages += 1;
      } while (cursor !== null);
    }
  }

  const rows = shardRows(months);
  await swapSnapshot(db, rows);

  let largestShard = 0;
  for (const row of rows) {
    largestShard = Math.max(largestShard, row.total);
  }
  const outcome = { largestShard, pages, shards: rows.length };
  if (
    outcome.largestShard > LIMITS.caseLawSitemapShardUrlLimit ||
    outcome.shards > LIMITS.caseLawSitemapIndexEntryLimit - 1
  ) {
    logger.error("case_law.sitemap.shard_refresh_over_capacity", {
      largestShard: outcome.largestShard,
      shards: outcome.shards,
    });
  }
  return outcome;
};
