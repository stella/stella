import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { caseLawDecisions } from "@/api/db/schema";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";

const SITEMAP_SHARD_BUCKET_COUNT = 64;
const SITEMAP_SHARD_BUCKET_WIDTH = 2;
const SITEMAP_UNDATED_YEAR = "undated";
const SITEMAP_UNDATED_MONTH = "00";
const SITEMAP_ALL_BUCKET = "all";
const SITEMAP_COUNTRY_PATTERN = "^[a-z]{3}$";
const SITEMAP_YEAR_PATTERN = "^(?:\\d{4}|undated)$";
const SITEMAP_MONTH_PATTERN = "^(?:0[1-9]|1[0-2]|00)$";
const SITEMAP_BUCKET_PATTERN = "^(?:all|[0-9]{2})$";

export const sitemapShardDecisionsQuerySchema = t.Object({
  country: t.String({ pattern: SITEMAP_COUNTRY_PATTERN }),
  year: t.String({ pattern: SITEMAP_YEAR_PATTERN }),
  month: t.String({ pattern: SITEMAP_MONTH_PATTERN }),
  bucket: t.Optional(t.String({ pattern: SITEMAP_BUCKET_PATTERN })),
});

type SitemapShardDecisionsQuery = Static<
  typeof sitemapShardDecisionsQuerySchema
>;

type NaturalShardRow = {
  country: string;
  lastmod: Date | null;
  month: string;
  total: number;
  year: string;
};

const decisionYearSql = sql<string>`COALESCE(to_char(${caseLawDecisions.decisionDate}, 'YYYY'), ${SITEMAP_UNDATED_YEAR})`;
const decisionMonthSql = sql<string>`COALESCE(to_char(${caseLawDecisions.decisionDate}, 'MM'), ${SITEMAP_UNDATED_MONTH})`;
const decisionBucketSql = sql<string>`lpad(mod(hashtext(${caseLawDecisions.id}::text)::bigint + 2147483648, ${SITEMAP_SHARD_BUCKET_COUNT})::text, ${SITEMAP_SHARD_BUCKET_WIDTH}, '0')`;

const getCountryPathSegment = (country: string): string =>
  country.toLowerCase();

const getBucketCountForNaturalShard = (total: number): number =>
  total <= LIMITS.caseLawSitemapUrlLimit ? 1 : SITEMAP_SHARD_BUCKET_COUNT;

const getBucketPathSegment = (index: number): string =>
  String(index).padStart(SITEMAP_SHARD_BUCKET_WIDTH, "0");

const getLastmod = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

const getShardConditions = ({
  bucket = SITEMAP_ALL_BUCKET,
  country,
  month,
  year,
}: SitemapShardDecisionsQuery): SQL[] | { error: "invalidShard" } => {
  const conditions: SQL[] = [
    eq(caseLawDecisions.country, country.toUpperCase()),
  ];

  if (year === SITEMAP_UNDATED_YEAR || month === SITEMAP_UNDATED_MONTH) {
    if (year !== SITEMAP_UNDATED_YEAR || month !== SITEMAP_UNDATED_MONTH) {
      return { error: "invalidShard" };
    }
    conditions.push(isNull(caseLawDecisions.decisionDate));
  } else {
    const startDate = `${year}-${month}-01`;
    const endMonth =
      month === "12" ? "01" : String(Number(month) + 1).padStart(2, "0");
    const endYear = month === "12" ? String(Number(year) + 1) : year;
    conditions.push(
      sql`${caseLawDecisions.decisionDate} >= ${startDate}`,
      sql`${caseLawDecisions.decisionDate} < ${`${endYear}-${endMonth}-01`}`,
    );
  }

  if (bucket !== SITEMAP_ALL_BUCKET) {
    conditions.push(sql`${decisionBucketSql} = ${bucket}`);
  }

  return conditions;
};

export const listSitemapShardsHandler = async (
  caseLawDb: CaseLawPublicReadDb,
) => {
  const naturalShards = await caseLawDb((tx) =>
    tx
      .select({
        country: caseLawDecisions.country,
        year: decisionYearSql,
        month: decisionMonthSql,
        total: sql<number>`count(*)::int`,
        lastmod: sql<Date | null>`max(${caseLawDecisions.updatedAt})`,
      })
      .from(caseLawDecisions)
      .groupBy(caseLawDecisions.country, decisionYearSql, decisionMonthSql)
      .orderBy(
        asc(caseLawDecisions.country),
        desc(decisionYearSql),
        desc(decisionMonthSql),
      ),
  );

  const items: {
    bucket: string;
    country: string;
    lastmod: string | null;
    month: string;
    year: string;
  }[] = [];

  for (const shard of naturalShards as NaturalShardRow[]) {
    const bucketCount = getBucketCountForNaturalShard(shard.total);
    if (bucketCount === 1) {
      items.push({
        bucket: SITEMAP_ALL_BUCKET,
        country: getCountryPathSegment(shard.country),
        lastmod: getLastmod(shard.lastmod),
        month: shard.month,
        year: shard.year,
      });
      continue;
    }

    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      items.push({
        bucket: getBucketPathSegment(bucketIndex),
        country: getCountryPathSegment(shard.country),
        lastmod: getLastmod(shard.lastmod),
        month: shard.month,
        year: shard.year,
      });
    }
  }

  if (items.length > LIMITS.caseLawSitemapIndexEntryLimit - 1) {
    return status(500, {
      message: "Case-law sitemap shard count exceeds sitemap index capacity.",
    });
  }

  return {
    items,
    limit: LIMITS.caseLawSitemapIndexEntryLimit,
    nextCursor: null,
  };
};

export const listSitemapShardDecisionsHandler = async (
  query: SitemapShardDecisionsQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const conditions = getShardConditions(query);
  if ("error" in conditions) {
    return status(400, { message: "Invalid sitemap shard" });
  }

  const rows = await caseLawDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        slug: caseLawDecisions.slug,
        country: caseLawDecisions.country,
        court: caseLawDecisions.court,
        decisionDate: caseLawDecisions.decisionDate,
        updatedAt: caseLawDecisions.updatedAt,
      })
      .from(caseLawDecisions)
      .where(and(...conditions))
      .orderBy(desc(caseLawDecisions.updatedAt), desc(caseLawDecisions.id))
      .limit(LIMITS.caseLawSitemapUrlLimit + 1),
  );

  if (rows.length > LIMITS.caseLawSitemapUrlLimit) {
    return status(500, {
      message: "Case-law sitemap shard exceeds sitemap URL capacity.",
    });
  }

  return {
    items: rows,
    limit: LIMITS.caseLawSitemapUrlLimit,
    nextCursor: null,
  };
};
