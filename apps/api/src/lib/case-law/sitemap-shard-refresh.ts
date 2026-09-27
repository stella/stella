import { and, eq, inArray, sql } from "drizzle-orm";

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

type RefreshDb = Pick<typeof rootDb, "select" | "transaction">;

/**
 * Published, redistributable decisions of the public countries, counted per
 * month and bucket with their newest update. Every column it reads is on
 * `case_law_decisions_sitemap_shard_idx`, so the count is an index scan rather
 * than a heap and TOAST read per decision. Exported for the plan test, which
 * holds it to that index.
 */
export const sitemapBucketCountsQuery = (db: Pick<RefreshDb, "select">) =>
  db
    .select({
      country: caseLawDecisions.country,
      year: decisionYearSql.as("year"),
      month: decisionMonthSql.as("month"),
      bucket: decisionBucketSql.as("bucket"),
      total: sql<number>`count(*)::int`.as("total"),
      lastModifiedAt: sql<Date>`max(${caseLawDecisions.updatedAt})`.as(
        "last_modified_at",
      ),
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(
      and(
        redistributableCaseLawSource,
        publishedCaseLawDecision,
        inArray(caseLawDecisions.country, [...PUBLIC_CASE_LAW_COUNTRIES]),
      ),
    )
    .groupBy(
      caseLawDecisions.country,
      decisionYearSql,
      decisionMonthSql,
      decisionBucketSql,
    );

/**
 * Recount the public sitemap shards and replace the snapshot the public index
 * reads, in one transaction, so a reader sees the previous snapshot or this
 * one, never a mix. A month becomes one `all` row, or one row per bucket once
 * it passes the split threshold. The index read refuses a snapshot it cannot
 * serve, so an over-capacity count is logged here rather than withheld.
 */
export const refreshCaseLawSitemapShards = async (
  db: RefreshDb,
): Promise<{ largestShard: number; shards: number }> =>
  await db.transaction(async (tx) => {
    await tx.delete(caseLawSitemapShards).where(sql`true`);
    await tx.execute(sql`
      WITH counts AS ${sitemapBucketCountsQuery(tx)},
      months AS (
        SELECT
          counts.*,
          sum(counts.total) OVER month_window AS month_total,
          max(counts.last_modified_at) OVER month_window AS month_last_modified_at
        FROM counts
        WINDOW month_window AS (PARTITION BY counts.country, counts.year, counts.month)
      )
      INSERT INTO ${caseLawSitemapShards}
        (country, year, month, bucket, total, last_modified_at)
      SELECT country, year, month, bucket, total, last_modified_at
      FROM months
      WHERE month_total > ${SITEMAP_SHARD_SPLIT_THRESHOLD}
      UNION ALL
      SELECT DISTINCT
        country, year, month, ${sql.raw(`'${SITEMAP_ALL_BUCKET}'`)},
        month_total, month_last_modified_at
      FROM months
      WHERE month_total <= ${SITEMAP_SHARD_SPLIT_THRESHOLD}
    `);

    const [summary] = await tx
      .select({
        shards: sql<number>`count(*)::int`,
        largestShard: sql<number>`coalesce(max(${caseLawSitemapShards.total}), 0)::int`,
      })
      .from(caseLawSitemapShards);
    const outcome = {
      largestShard: summary?.largestShard ?? 0,
      shards: summary?.shards ?? 0,
    };
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
  });
