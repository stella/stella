import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  legislationDocuments,
  legislationSources,
  STATUTE_SITEMAP_BUCKET_COUNT,
  statuteSitemapBucket,
} from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import { groupableSql } from "@/api/lib/groupable-sql";
import { redistributableLegislationSource } from "@/api/lib/legal-search/legislation-redistribution";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";

const SITEMAP_ALL_BUCKET = "all";
const SITEMAP_COUNTRY_PATTERN = "^[a-z]{2,3}$";
const SITEMAP_BUCKET_PATTERN = "^(?:all|[0-9]{2})$";

export const sitemapShardStatutesQuerySchema = t.Object({
  country: t.String({ pattern: SITEMAP_COUNTRY_PATTERN }),
  bucket: t.Optional(t.String({ pattern: SITEMAP_BUCKET_PATTERN })),
});

type SitemapShardStatutesQuery = Static<typeof sitemapShardStatutesQuerySchema>;

type CountryShardRow = {
  country: string;
  lastmod: string;
  total: number;
};

type BucketShardRow = CountryShardRow & {
  bucket: string;
};

// Rendered into both the SELECT list and the GROUP BY of the shard queries;
// see the same note over the case-law fragments. `groupableSql` rejects a
// bound constant at construction, because drizzle numbers placeholders per
// render and Postgres then reads the two copies as different expressions.
const statuteBucketSql = groupableSql(
  statuteSitemapBucket(legislationDocuments.eli),
);

/**
 * The slug of a Work's latest consolidation, which is the address its page is
 * canonical at. Ingestion derives each row's slug on its own, so a title
 * repair leaves older consolidations carrying an older segment; those resolve
 * too, but listing them would put several URLs for one page in the index.
 *
 * `array_agg(... ORDER BY ...)[1]` is a greatest-per-group pick a hash
 * aggregate can serve, so the shard never sorts its whole row set. The WHERE
 * keeps only rows that have a slug, so the array is never empty.
 */
const canonicalSlugSql = sql<string>`(array_agg(${legislationDocuments.slug} ORDER BY coalesce(${legislationDocuments.versionValidFrom}, DATE '0001-01-01') DESC, ${legislationDocuments.id} DESC))[1]`;

// The only timestamp a sitemap carries is a calendar day, and rendering it in
// SQL keeps the payload free of a driver's timestamp representation: PGlite
// hands back a string where postgres.js hands back a Date. ISO days also
// compare as text, so an outer `max` over these still picks the newest.
const statuteLastmodSql = sql<string>`to_char(max(${legislationDocuments.updatedAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

const publishedStatuteConditions = (): SQL[] => [
  isNotNull(legislationDocuments.slug),
  redistributableLegislationSource,
];

const getCountryPathSegment = (country: string): string =>
  country.toLowerCase();

const getBucketCountForCountryShard = (total: number): number =>
  total <= LIMITS.statuteSitemapShardUrlLimit
    ? 1
    : STATUTE_SITEMAP_BUCKET_COUNT;

/**
 * One row per Work: its canonical slug, the bucket its ELI hashes into, and
 * the newest timestamp any of its consolidations carries.
 *
 * Grouping on the Work key rather than the slug is what keeps a Work to one
 * URL. The bucket is a function of the grouped ELI, so filtering rows by it
 * selects whole Works and the shard reading them sees every consolidation.
 */
const statuteWorks = (
  tx: LegislationReadTransaction,
  conditions: readonly SQL[],
) =>
  tx
    .select({
      country: legislationDocuments.country,
      // Aliased: drizzle cannot reference a raw SQL field of a subquery by
      // name unless the subquery names it.
      bucket: statuteBucketSql.as("bucket"),
      slug: canonicalSlugSql.as("slug"),
      lastmod: statuteLastmodSql.as("lastmod"),
    })
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .where(and(...conditions, ...publishedStatuteConditions()))
    .groupBy(
      legislationDocuments.country,
      legislationDocuments.sourceId,
      legislationDocuments.eli,
      legislationDocuments.language,
    )
    .as("works");

const readStatuteSitemapBucketShards = async (
  tx: LegislationReadTransaction,
) => {
  const works = statuteWorks(tx, []);

  return await tx
    .select({
      country: works.country,
      bucket: works.bucket,
      total: sql<number>`count(distinct ${works.slug})::int`,
      lastmod: sql<string>`max(${works.lastmod})`,
    })
    .from(works)
    .groupBy(works.country, works.bucket)
    .orderBy(asc(works.country), asc(works.bucket))
    // Fetch one past the index cap so an overflowing bucket set is rejected.
    .limit(LIMITS.statuteSitemapIndexEntryLimit + 1);
};

export const listStatuteSitemapShardsHandler = async (
  legislationDb: LegislationReadDb,
) => {
  const { countryShards, bucketShardRows } = await legislationDb(async (tx) => {
    const works = statuteWorks(tx, []);
    const countries = await tx
      .select({
        country: works.country,
        total: sql<number>`count(distinct ${works.slug})::int`,
        lastmod: sql<string>`max(${works.lastmod})`,
      })
      .from(works)
      .groupBy(works.country)
      .orderBy(asc(works.country))
      // The guard below rejects an index that would exceed this, so the cap
      // never truncates a servable index.
      .limit(LIMITS.statuteSitemapIndexEntryLimit);
    const needsBucketShards = countries.some(
      (shard) => shard.total > LIMITS.statuteSitemapShardUrlLimit,
    );
    const buckets = needsBucketShards
      ? await readStatuteSitemapBucketShards(tx)
      : [];

    return { countryShards: countries, bucketShardRows: buckets };
  });

  // Reject rather than serve a partial index: more bucket shards than the
  // index can hold means the bucket read truncated, so the assembled sitemap
  // would silently omit buckets and the statutes in them.
  if (bucketShardRows.length > LIMITS.statuteSitemapIndexEntryLimit) {
    return status(500, {
      message: "Statute sitemap bucket shards exceed sitemap index capacity.",
    });
  }

  const bucketRowsByCountry = new Map<string, BucketShardRow[]>();
  for (const bucketShard of bucketShardRows) {
    const storedBucketRows = bucketRowsByCountry.get(bucketShard.country);
    const bucketRows = arrayOrEmpty(storedBucketRows);
    bucketRows.push(bucketShard);
    bucketRowsByCountry.set(bucketShard.country, bucketRows);
  }

  const items: {
    bucket: string;
    country: string;
    lastmod: string;
  }[] = [];

  for (const shard of countryShards) {
    if (getBucketCountForCountryShard(shard.total) === 1) {
      items.push({
        bucket: SITEMAP_ALL_BUCKET,
        country: getCountryPathSegment(shard.country),
        lastmod: shard.lastmod,
      });
      continue;
    }

    const storedBucketRows = bucketRowsByCountry.get(shard.country);
    const bucketRows = arrayOrEmpty(storedBucketRows);
    if (bucketRows.length === 0) {
      return status(500, {
        message: "Statute sitemap bucket rows missing for country shard.",
      });
    }

    for (const bucketRow of bucketRows) {
      if (bucketRow.total > LIMITS.statuteSitemapShardUrlLimit) {
        return status(500, {
          message: "Statute sitemap bucket exceeds shard capacity.",
        });
      }

      items.push({
        bucket: bucketRow.bucket,
        country: getCountryPathSegment(shard.country),
        lastmod: bucketRow.lastmod,
      });
    }
  }

  if (items.length > LIMITS.statuteSitemapIndexEntryLimit) {
    return status(500, {
      message: "Statute sitemap shard count exceeds sitemap index capacity.",
    });
  }

  return {
    items,
    limit: LIMITS.statuteSitemapIndexEntryLimit,
    nextCursor: null,
  };
};

/**
 * One shard's statutes: the canonical address of every published Work in a
 * jurisdiction, or in one hashed bucket of it.
 *
 * A Work is emitted once, at its readable URL, and that URL always names the
 * latest consolidation: the dated `/v/` addresses are alternate spellings of
 * the same text and would be duplicate content in an index. Two Works whose
 * latest consolidations mint the same segment share a page as well, so the
 * outer grouping collapses them into the one URL the resolver answers with.
 */
export const listStatuteSitemapStatutesHandler = async (
  query: SitemapShardStatutesQuery,
  legislationDb: LegislationReadDb,
) => {
  const bucket = query.bucket ?? SITEMAP_ALL_BUCKET;
  const conditions: SQL[] = [
    eq(legislationDocuments.country, query.country.toUpperCase()),
  ];
  if (bucket !== SITEMAP_ALL_BUCKET) {
    // Seekable: `legislation_documents_sitemap_bucket_idx` leads with the
    // country and this expression, so the shard reads only its own bucket.
    conditions.push(sql`${statuteBucketSql} = ${bucket}`);
  }

  const rows = await legislationDb(async (tx) => {
    const works = statuteWorks(tx, conditions);

    return await tx
      .select({
        country: works.country,
        slug: works.slug,
        lastmod: sql<string>`max(${works.lastmod})`,
      })
      .from(works)
      .groupBy(works.country, works.slug)
      .orderBy(asc(works.country), asc(works.slug))
      .limit(LIMITS.statuteSitemapShardUrlLimit + 1);
  });

  if (rows.length > LIMITS.statuteSitemapShardUrlLimit) {
    return status(500, {
      message: "Statute sitemap shard exceeds sitemap URL capacity.",
    });
  }

  return {
    items: rows,
    limit: LIMITS.statuteSitemapShardUrlLimit,
    nextCursor: null,
  };
};
