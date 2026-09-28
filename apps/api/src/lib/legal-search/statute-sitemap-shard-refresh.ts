import { sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { statuteSitemapShards } from "@/api/db/schema";
import { statuteWorksQuery } from "@/api/lib/legal-search/statute-sitemap-shard-sql";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

type RefreshDb = Pick<typeof rootDb, "select" | "transaction">;

// Leave room for Works added between hourly refreshes. A live shard read
// still refuses to serve more than the URL limit.
export const STATUTE_SITEMAP_SHARD_SPLIT_THRESHOLD = Math.floor(
  LIMITS.statuteSitemapShardUrlLimit / 2,
);

/** Replace the public index atomically from the same Work grouping as shard reads. */
export const refreshStatuteSitemapShards = async (db: RefreshDb) =>
  await db.transaction(async (tx) => {
    await tx.delete(statuteSitemapShards).where(sql`true`);
    await tx.execute(sql`
      WITH works AS ${statuteWorksQuery(tx, [])},
      countries AS (
        SELECT country, count(DISTINCT slug)::int AS total, max(lastmod) AS lastmod
        FROM works
        GROUP BY country
      ),
      buckets AS (
        SELECT country, bucket, count(DISTINCT slug)::int AS total,
          max(lastmod) AS lastmod
        FROM works
        GROUP BY country, bucket
      )
      INSERT INTO ${statuteSitemapShards} (country, bucket, total, lastmod)
      SELECT country, 'all', total, lastmod
      FROM countries
      WHERE total <= ${STATUTE_SITEMAP_SHARD_SPLIT_THRESHOLD}
      UNION ALL
      SELECT buckets.country, buckets.bucket, buckets.total, buckets.lastmod
      FROM buckets
      INNER JOIN countries ON countries.country = buckets.country
      WHERE countries.total > ${STATUTE_SITEMAP_SHARD_SPLIT_THRESHOLD}
    `);

    const [summary] = await tx
      .select({
        shards: sql<number>`count(*)::int`,
        largestShard: sql<number>`coalesce(max(${statuteSitemapShards.total}), 0)::int`,
      })
      .from(statuteSitemapShards);
    const outcome = {
      largestShard: summary?.largestShard ?? 0,
      shards: summary?.shards ?? 0,
    };
    if (
      outcome.largestShard > LIMITS.statuteSitemapShardUrlLimit ||
      outcome.shards > LIMITS.statuteSitemapIndexEntryLimit
    ) {
      logger.error("legislation.sitemap.shard_refresh_over_capacity", outcome);
    }
    return outcome;
  });
