import { asc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import { legislationDocuments, statuteSitemapShards } from "@/api/db/schema";
import {
  projectStatuteSitemapShard,
  projectStatuteSitemapStatute,
} from "@/api/handlers/legislation/catalog-response";
import { publicLawCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import {
  SITEMAP_ALL_BUCKET,
  statuteBucketSql,
  statuteWorksQuery,
} from "@/api/lib/legal-search/statute-sitemap-shard-sql";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";

const SITEMAP_COUNTRY_PATTERN = "^[a-z]{2,3}$";
const SITEMAP_BUCKET_PATTERN = "^(?:all|[0-9]{2})$";

export const sitemapShardStatutesQuerySchema = t.Object({
  country: t.String({ pattern: SITEMAP_COUNTRY_PATTERN }),
  bucket: t.Optional(t.String({ pattern: SITEMAP_BUCKET_PATTERN })),
});

type SitemapShardStatutesQuery = Static<typeof sitemapShardStatutesQuerySchema>;

const getCountryPathSegment = (country: string): string =>
  country.toLowerCase();

export const statuteSitemapIndexQuery = (tx: LegislationReadTransaction) =>
  tx
    .select({
      country: statuteSitemapShards.country,
      bucket: statuteSitemapShards.bucket,
      lastmod: statuteSitemapShards.lastmod,
      total: statuteSitemapShards.total,
    })
    .from(statuteSitemapShards)
    .where(
      inArray(statuteSitemapShards.country, [...PUBLIC_LEGISLATION_COUNTRIES]),
    )
    .orderBy(
      asc(statuteSitemapShards.country),
      asc(statuteSitemapShards.bucket),
    )
    .limit(LIMITS.statuteSitemapIndexEntryLimit + 1);

export const listStatuteSitemapShardsHandler = async (
  legislationDb: LegislationReadDb,
) => {
  const shards = await legislationDb(
    async (tx) => await statuteSitemapIndexQuery(tx),
  );

  if (shards.length > LIMITS.statuteSitemapIndexEntryLimit) {
    return status(500, {
      message: "Statute sitemap shard count exceeds sitemap index capacity.",
    });
  }

  if (
    shards.some((shard) => shard.total > LIMITS.statuteSitemapShardUrlLimit)
  ) {
    return status(500, {
      message: "Statute sitemap bucket exceeds shard capacity.",
    });
  }

  return {
    items: shards.map((shard) =>
      projectStatuteSitemapShard({
        bucket: shard.bucket,
        country: getCountryPathSegment(shard.country),
        lastmod: shard.lastmod,
      }),
    ),
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
type StatuteSitemapShardQueryOptions = {
  query: SitemapShardStatutesQuery;
  tx: LegislationReadTransaction;
};

/** The public shard read, shared with its access-path contract. */
export const statuteSitemapShardQuery = ({
  query,
  tx,
}: StatuteSitemapShardQueryOptions) => {
  const bucket = query.bucket ?? SITEMAP_ALL_BUCKET;
  const conditions: SQL[] = [
    eq(legislationDocuments.country, query.country.toUpperCase()),
  ];
  if (bucket !== SITEMAP_ALL_BUCKET) {
    // Seekable: `legislation_documents_sitemap_bucket_idx` leads with the
    // country and this expression, so the shard reads only its own bucket.
    conditions.push(sql`${statuteBucketSql} = ${bucket}`);
  }

  const works = statuteWorksQuery(tx, conditions).as("works");

  return tx
    .select({
      country: works.country,
      slug: works.slug,
      lastmod: sql<string>`max(${works.lastmod})`,
    })
    .from(works)
    .groupBy(works.country, works.slug)
    .orderBy(asc(works.country), asc(works.slug))
    .limit(LIMITS.statuteSitemapShardUrlLimit + 1);
};

export const listStatuteSitemapStatutesHandler = async (
  query: SitemapShardStatutesQuery,
  legislationDb: LegislationReadDb,
) => {
  const unavailable = publicLawCountryUnavailable(query.country);
  if (unavailable !== null) {
    return unavailable;
  }

  const rows = await legislationDb(
    async (tx) => await statuteSitemapShardQuery({ query, tx }),
  );

  if (rows.length > LIMITS.statuteSitemapShardUrlLimit) {
    return status(500, {
      message: "Statute sitemap shard exceeds sitemap URL capacity.",
    });
  }

  return {
    items: rows.map(projectStatuteSitemapStatute),
    limit: LIMITS.statuteSitemapShardUrlLimit,
    nextCursor: null,
  };
};
