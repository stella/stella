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
import { envBase } from "@/api/env-base";
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

/** Both budgets in milliseconds. */
export type SitemapRefreshBudget = {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
};

/**
 * A page reads a bounded range of one index and the swap rewrites a table of
 * at most one row per sitemap index entry, so a statement that runs past this
 * is not making progress; it is cancelled and the next tick starts over.
 */
const MAX_STATEMENT_TIMEOUT_MS = 30_000;
/** A page takes no lock a writer holds; waiting on one is not progress. */
const PAGE_LOCK_TIMEOUT_MS = 5000;

/**
 * The statement and lock budgets for one pool.
 *
 * The pool closes a connection that has been silent for its idle timeout,
 * and a statement that is still running sends nothing, so the pool would drop
 * a long statement's connection mid-flight with a driver error rather than a
 * database one. Every statement here is held under half that timeout, so the
 * database cancels a stuck statement first and the connection survives it.
 * The whole refresh may run far longer: only a single silent statement is
 * bounded by the pool, and each page is its own statement.
 */
export const sitemapRefreshBudget = (
  poolIdleTimeoutS: number,
): SitemapRefreshBudget => {
  const statementTimeoutMs =
    poolIdleTimeoutS > 0
      ? Math.min(
          MAX_STATEMENT_TIMEOUT_MS,
          Math.floor((poolIdleTimeoutS * 1000) / 2),
        )
      : MAX_STATEMENT_TIMEOUT_MS;
  return {
    lockTimeoutMs: Math.min(PAGE_LOCK_TIMEOUT_MS, statementTimeoutMs),
    statementTimeoutMs,
  };
};

type RefreshDb = Pick<typeof rootDb, "transaction">;
type RefreshTransaction = Parameters<
  Parameters<RefreshDb["transaction"]>[0]
>[0];

/**
 * Both budgets, set LOCAL so they end with the transaction. Written as raw
 * statements because `SET LOCAL` takes a literal, not a bind parameter; the
 * values are integers computed here.
 */
const setTransactionBudget = async (
  tx: RefreshTransaction,
  { lockTimeoutMs, statementTimeoutMs }: SitemapRefreshBudget,
): Promise<void> => {
  if (
    !Number.isInteger(lockTimeoutMs) ||
    !Number.isInteger(statementTimeoutMs)
  ) {
    return panic("Sitemap refresh budgets must be integer milliseconds");
  }
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`));
  await tx.execute(
    sql.raw(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`),
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

/**
 * Add one page's counts to the running totals and answer where the next page
 * resumes, or null once the phase is walked to its end.
 */
const accumulatePage = (
  months: CountryMonths,
  country: string,
  rows: unknown[],
): SitemapRefreshCursor | null => {
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
    const monthKey = `${country}|${row.year}|${row.month}`;
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
  return cursor;
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    panic("SchedulerAborted");
  }
};

/**
 * Walk every public country's sitemap index entries, a page per statement,
 * inside one read-only REPEATABLE READ transaction: each statement is short,
 * and every page reads the same snapshot, so a decision updated or re-dated
 * during the walk cannot move past the cursor and be counted twice or skipped.
 */
const countSitemapMonths = async (
  db: RefreshDb,
  budget: SitemapRefreshBudget,
  pageSize: number,
  signal: AbortSignal | undefined,
): Promise<{ months: CountryMonths; pages: number }> =>
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    await setTransactionBudget(tx, budget);
    const months: CountryMonths = new Map();
    let pages = 0;
    for (const country of PUBLIC_CASE_LAW_COUNTRIES) {
      for (const phase of ["dated", "undated"] as const) {
        let cursor: SitemapRefreshCursor | null = null;
        do {
          throwIfAborted(signal);
          const page = sitemapRefreshPageSql({
            country,
            cursor,
            pageSize,
            phase,
          });
          // db-await-in-loop: a keyset walk; each page resumes after the previous page's last index entry
          const rows = executedRows(await tx.execute(page));
          cursor = accumulatePage(months, country, rows);
          pages += 1;
        } while (cursor !== null);
      }
    }
    return { months, pages };
  });

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
const swapSnapshot = async (
  db: RefreshDb,
  { statementTimeoutMs }: SitemapRefreshBudget,
  rows: ShardRow[],
  signal: AbortSignal | undefined,
): Promise<void> => {
  await db.transaction(async (tx) => {
    // The lock wait covers an overlapping refresh's swap, itself bounded by
    // the same statement budget.
    await setTransactionBudget(tx, {
      lockTimeoutMs: statementTimeoutMs,
      statementTimeoutMs,
    });
    await tx.execute(
      sql`LOCK TABLE ${caseLawSitemapShards} IN SHARE ROW EXCLUSIVE MODE`,
    );
    await tx.delete(caseLawSitemapShards).where(sql`true`);
    // One statement for the whole snapshot, sent as one JSON document: its
    // size is bounded by the index entry limit, where a VALUES list would be
    // bounded by the bind-parameter limit. `::text::jsonb` so the driver binds
    // text rather than encoding the JSON string a second time.
    const snapshot = JSON.stringify(
      rows.map((row) => ({
        bucket: row.bucket,
        country: row.country,
        last_modified_at: row.lastModifiedAt.toISOString(),
        month: row.month,
        total: row.total,
        year: row.year,
      })),
    );
    await tx.execute(sql`
      INSERT INTO ${caseLawSitemapShards}
        (country, year, month, bucket, total, last_modified_at)
      SELECT country, year, month, bucket, total, last_modified_at
      FROM jsonb_to_recordset(${snapshot}::text::jsonb) AS shard(
        country varchar,
        year varchar,
        month varchar,
        bucket varchar,
        total integer,
        last_modified_at timestamptz
      )
    `);
    // A run whose lease was lost or whose deadline passed while it wrote
    // rolls back here rather than replacing a newer run's snapshot.
    throwIfAborted(signal);
  });
};

/**
 * Recount the public sitemap shards and replace the snapshot the public index
 * reads.
 *
 * The count is a walk of the sitemap index in pages, each its own short
 * statement under its own timeout, so no statement's work grows with the
 * corpus, and all of them read one snapshot. The counts accumulate here and
 * are written in one swap at the end: an aborted or failed walk leaves the
 * previous snapshot in place.
 *
 * The index read refuses a snapshot it cannot serve, so an over-capacity
 * count is logged here rather than withheld.
 */
export const refreshCaseLawSitemapShards = async (
  db: RefreshDb,
  {
    pageSize = SITEMAP_REFRESH_PAGE_SIZE,
    poolIdleTimeoutS = envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
    signal,
  }: {
    pageSize?: number;
    /** The idle timeout of the pool `db` draws from; see `sitemapRefreshBudget`. */
    poolIdleTimeoutS?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ largestShard: number; pages: number; shards: number }> => {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    return panic("Sitemap refresh page size must be a positive integer");
  }
  const budget = sitemapRefreshBudget(poolIdleTimeoutS);
  const { months, pages } = await countSitemapMonths(
    db,
    budget,
    pageSize,
    signal,
  );

  throwIfAborted(signal);
  const rows = shardRows(months);
  await swapSnapshot(db, budget, rows, signal);

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
