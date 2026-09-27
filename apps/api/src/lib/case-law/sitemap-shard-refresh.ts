import { and, asc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

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
  SITEMAP_ALL_BUCKET,
  SITEMAP_UNDATED_YEAR,
} from "@/api/lib/case-law/sitemap-shard-sql";
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

const SNAPSHOT_INSERT_BATCH_SIZE = 1000;

type RefreshDb = Pick<typeof rootDb, "select" | "transaction">;

type BucketCount = {
  bucket: string;
  lastModifiedAt: Date;
  month: string;
  total: number;
};

type SitemapShardRow = typeof caseLawSitemapShards.$inferInsert;

export type SitemapShardRefreshOutcome =
  | { type: "refreshed"; shards: number }
  | { type: "overCapacity"; reason: "bucket" | "index" };

export const sitemapYearRange = (year: number): SQL[] => [
  gte(caseLawDecisions.decisionDate, `${year}-01-01`),
  lt(caseLawDecisions.decisionDate, `${year + 1}-01-01`),
];

// One year of one country, or its undated decisions, counted per month and
// bucket. Every column it reads is on `case_law_decisions_sitemap_shard_idx`,
// so the count is an index range rather than a heap read per decision.
// Exported unawaited for the plan test, which holds it to that index.
export const sitemapBucketCountsQuery = (
  db: RefreshDb,
  country: string,
  range: SQL[],
) =>
  db
    .select({
      month: decisionMonthSql,
      bucket: decisionBucketSql,
      total: sql<number>`count(*)::int`,
      lastModifiedAt: sql<Date>`max(${caseLawDecisions.updatedAt})`.mapWith(
        caseLawDecisions.updatedAt,
      ),
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(
      and(
        redistributableCaseLawSource,
        publishedCaseLawDecision,
        eq(caseLawDecisions.country, country),
        ...range,
      ),
    )
    .groupBy(decisionMonthSql, decisionBucketSql);

const readSitemapBucketCounts = async (
  db: RefreshDb,
  country: string,
  range: SQL[],
): Promise<BucketCount[]> => await sitemapBucketCountsQuery(db, country, range);

// The first dated year at or after `fromYear` holding a published decision of
// the country: a skip along the index, so years without decisions cost one
// probe between them rather than a count each.
const readNextDatedYear = async (
  db: RefreshDb,
  country: string,
  fromYear: number | null,
): Promise<number | null> => {
  const [row] = await db
    .select({ decisionDate: caseLawDecisions.decisionDate })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.country, country),
        publishedCaseLawDecision,
        fromYear === null
          ? isNotNull(caseLawDecisions.decisionDate)
          : gte(caseLawDecisions.decisionDate, `${fromYear}-01-01`),
      ),
    )
    .orderBy(asc(caseLawDecisions.decisionDate))
    .limit(1);

  return row === undefined || row.decisionDate === null
    ? null
    : Number(row.decisionDate.slice(0, 4));
};

// A month becomes one `all` row, or one row per bucket once it is large enough
// to split.
const toShardRows = (
  country: string,
  year: string,
  counts: readonly BucketCount[],
): SitemapShardRow[] => {
  const byMonth = new Map<string, BucketCount[]>();
  for (const count of counts) {
    const monthCounts = byMonth.get(count.month) ?? [];
    monthCounts.push(count);
    byMonth.set(count.month, monthCounts);
  }

  return [...byMonth].flatMap(([month, monthCounts]) => {
    const total = monthCounts.reduce((sum, count) => sum + count.total, 0);
    if (total > SITEMAP_SHARD_SPLIT_THRESHOLD) {
      return monthCounts.map((count) => ({
        country,
        year,
        month,
        bucket: count.bucket,
        total: count.total,
        lastModifiedAt: count.lastModifiedAt,
      }));
    }

    const lastModifiedAt = new Date(
      Math.max(...monthCounts.map((count) => count.lastModifiedAt.getTime())),
    );
    return [
      {
        country,
        year,
        month,
        bucket: SITEMAP_ALL_BUCKET,
        total,
        lastModifiedAt,
      },
    ];
  });
};

const readCountryShardRows = async (
  db: RefreshDb,
  country: string,
): Promise<SitemapShardRow[]> => {
  // Undated decisions group under the `00` month the month fragment falls
  // back to, so they form one shard like any month.
  const rows = toShardRows(
    country,
    SITEMAP_UNDATED_YEAR,
    await readSitemapBucketCounts(db, country, [
      isNull(caseLawDecisions.decisionDate),
    ]),
  );

  let year = await readNextDatedYear(db, country, null);
  while (year !== null) {
    // db-await-in-loop: one bounded count per year with decisions; a single statement over the whole country is the corpus-wide aggregate this refresh exists to keep out of one statement
    const counts = await readSitemapBucketCounts(
      db,
      country,
      sitemapYearRange(year),
    );
    rows.push(...toShardRows(country, String(year), counts));
    // db-await-in-loop: the next year is found from where this one ended
    year = await readNextDatedYear(db, country, year + 1);
  }

  return rows;
};

/**
 * Recount the public sitemap shards and replace the snapshot the public index
 * reads. Each count is one country-year, so no statement grows with the
 * corpus; the replacement is one transaction, so a reader sees the previous
 * snapshot or this one, never a mix. A snapshot the index could not serve is
 * not written, and the previous one stays.
 */
// audit: skip - a derived public index recomputed from the corpus, not a user action
export const refreshCaseLawSitemapShards = async (
  db: RefreshDb,
): Promise<SitemapShardRefreshOutcome> => {
  const rows: SitemapShardRow[] = [];
  for (const country of PUBLIC_CASE_LAW_COUNTRIES) {
    // db-await-in-loop: countries are counted one after another so the refresh holds one connection and one statement at a time
    rows.push(...(await readCountryShardRows(db, country)));
  }

  if (rows.some((row) => row.total > LIMITS.caseLawSitemapShardUrlLimit)) {
    logger.error("case_law.sitemap.shard_refresh_over_capacity", {
      reason: "bucket",
      limit: LIMITS.caseLawSitemapShardUrlLimit,
    });
    return { type: "overCapacity", reason: "bucket" };
  }
  // The sitemap index carries one entry beside the shards.
  if (rows.length > LIMITS.caseLawSitemapIndexEntryLimit - 1) {
    logger.error("case_law.sitemap.shard_refresh_over_capacity", {
      reason: "index",
      shards: rows.length,
      limit: LIMITS.caseLawSitemapIndexEntryLimit,
    });
    return { type: "overCapacity", reason: "index" };
  }

  // `refreshed_at` defaults to the transaction's own `now()`, so every row of
  // one snapshot carries the same instant.
  await db.transaction(async (tx) => {
    await tx.delete(caseLawSitemapShards).where(sql`true`);
    for (
      let index = 0;
      index < rows.length;
      index += SNAPSHOT_INSERT_BATCH_SIZE
    ) {
      // db-await-in-loop: bounded insert batches inside the one replacing transaction
      await tx
        .insert(caseLawSitemapShards)
        .values(rows.slice(index, index + SNAPSHOT_INSERT_BATCH_SIZE));
    }
  });

  return { type: "refreshed", shards: rows.length };
};
