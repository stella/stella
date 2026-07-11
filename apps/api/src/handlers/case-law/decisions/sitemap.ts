import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";
import { arrayOrEmpty } from "@/api/lib/array";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { groupableSql } from "@/api/lib/groupable-sql";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

const SITEMAP_SHARD_BUCKET_COUNT = 64;
const SITEMAP_SHARD_BUCKET_WIDTH = 2;
const SITEMAP_UNDATED_YEAR = "undated";
const SITEMAP_UNDATED_MONTH = "00";
const SITEMAP_ALL_BUCKET = "all";
const SITEMAP_COUNTRY_PATTERN = "^[a-z]{2,3}$";
const SITEMAP_YEAR_PATTERN = "^(?:\\d{4}|undated)$";
const SITEMAP_MONTH_PATTERN = "^(?:0[1-9]|1[0-2]|00)$";
const SITEMAP_BUCKET_PATTERN = "^(?:all|[0-9]{2})$";
const SITEMAP_LANGUAGE_ALTERNATE_GROUP_BATCH_SIZE = 1000;
// Realistic ceiling for distinct language variants of one logical decision; used
// to bound the per-batch alternates read so a single languageGroupKey matching
// many rows cannot make the query grow unbounded. Single-sourced with the
// decision-detail alternate read (read-by-id.ts) via LIMITS.
const MAX_LANGUAGES_PER_ALTERNATE_GROUP =
  LIMITS.caseLawLanguageAlternatesPerGroupMax;
const LANGUAGE_SEGMENT_REGEX = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

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

type BucketShardRow = NaturalShardRow & {
  bucket: string;
};

type SitemapDecisionAlternate = {
  caseNumber: string;
  country: string;
  court: string;
  id: string;
  language: string;
  slug: string | null;
  updatedAt: Date;
};

type SitemapDecisionRow = SitemapDecisionAlternate & {
  languageGroupKey: string | null;
};

// These fragments are rendered into both the SELECT list and the GROUP BY (and
// ORDER BY) of the sitemap-shard queries. Postgres identifies a grouped SELECT
// expression by its rendered text, and every drizzle `sql` bind parameter gets a
// fresh placeholder number per render ($1 in SELECT, $3 in GROUP BY), so a bound
// constant would make the two renderings differ and Postgres would reject the
// query ("column ... must appear in the GROUP BY clause"). The constants below
// are module-level code values, never user input, so they are inlined with
// `sql.raw` (byte-identical every render) instead of bound. Genuinely dynamic
// values (e.g. the user-supplied `bucket` in getShardConditions) stay bound.
// Exported for the grouped-query regression test, which renders each fragment in
// both the SELECT list and the GROUP BY to assert Postgres accepts the grouping.
// `groupableSql` enforces the inlining invariant at construction: a bound
// constant here would panic at module load rather than fail a live query.
export const decisionYearSql = groupableSql(
  sql<string>`COALESCE(to_char(${caseLawDecisions.decisionDate}, 'YYYY'), ${sql.raw(`'${SITEMAP_UNDATED_YEAR}'`)})`,
);
export const decisionMonthSql = groupableSql(
  sql<string>`COALESCE(to_char(${caseLawDecisions.decisionDate}, 'MM'), ${sql.raw(`'${SITEMAP_UNDATED_MONTH}'`)})`,
);
export const decisionBucketSql = groupableSql(
  sql<string>`lpad(mod(hashtext(${caseLawDecisions.id}::text)::bigint + 2147483648, ${sql.raw(String(SITEMAP_SHARD_BUCKET_COUNT))})::text, ${sql.raw(String(SITEMAP_SHARD_BUCKET_WIDTH))}, '0')`,
);

const getCountryPathSegment = (country: string): string =>
  country.toLowerCase();

const getBucketCountForNaturalShard = (total: number): number =>
  total <= LIMITS.caseLawSitemapShardUrlLimit ? 1 : SITEMAP_SHARD_BUCKET_COUNT;

const getLastmod = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

const createNaturalShardKey = ({
  country,
  month,
  year,
}: {
  country: string;
  month: string;
  year: string;
}): string => `${country}\u0000${year}\u0000${month}`;

const normalizeLanguageSegment = (language: string): string | null => {
  const normalized = language.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalized || !LANGUAGE_SEGMENT_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
};

const chunkArray = <T>(
  items: readonly T[],
  chunkSize: number,
): readonly T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
};

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
  const { naturalShards, bucketShardRows } = await caseLawDb(async (tx) => {
    const natural = await tx
      .select({
        country: caseLawDecisions.country,
        year: decisionYearSql,
        month: decisionMonthSql,
        total: sql<number>`count(*)::int`,
        lastmod: sql<Date | null>`max(${caseLawDecisions.updatedAt})`,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(redistributableCaseLawSource)
      .groupBy(caseLawDecisions.country, decisionYearSql, decisionMonthSql)
      .orderBy(
        asc(caseLawDecisions.country),
        desc(decisionYearSql),
        desc(decisionMonthSql),
      )
      // Bound the natural-shard enumeration at the index entry limit so the
      // read cannot grow unbounded as the corpus spans more country/year
      // shards. The guard below already 500s once items exceed this limit,
      // so the cap never truncates a servable index.
      .limit(LIMITS.caseLawSitemapIndexEntryLimit);
    const needsBucketShards = natural.some(
      (shard) => shard.total > LIMITS.caseLawSitemapShardUrlLimit,
    );
    const buckets = needsBucketShards
      ? await tx
          .select({
            country: caseLawDecisions.country,
            year: decisionYearSql,
            month: decisionMonthSql,
            bucket: decisionBucketSql,
            total: sql<number>`count(*)::int`,
            lastmod: sql<Date | null>`max(${caseLawDecisions.updatedAt})`,
          })
          .from(caseLawDecisions)
          .innerJoin(
            caseLawSources,
            eq(caseLawSources.id, caseLawDecisions.sourceId),
          )
          .where(redistributableCaseLawSource)
          .groupBy(
            caseLawDecisions.country,
            decisionYearSql,
            decisionMonthSql,
            decisionBucketSql,
          )
          .orderBy(
            asc(caseLawDecisions.country),
            desc(decisionYearSql),
            desc(decisionMonthSql),
            asc(decisionBucketSql),
          )
          // Fetch one past the index cap so an overflowing bucket set is
          // rejected below. Capping exactly at the limit could truncate a
          // natural shard's buckets mid-shard — the partial shard's row count is
          // still nonzero, so it would emit only the fetched buckets and
          // silently drop the rest of that shard from the index.
          .limit(LIMITS.caseLawSitemapIndexEntryLimit + 1)
      : [];

    return { naturalShards: natural, bucketShardRows: buckets };
  });

  // Reject rather than serve a partial index: more bucket shards than the index
  // can hold means the bucket read above truncated (possibly mid-shard), so the
  // assembled sitemap would silently omit buckets and their decisions.
  if (bucketShardRows.length > LIMITS.caseLawSitemapIndexEntryLimit) {
    return status(500, {
      message: "Case-law sitemap bucket shards exceed sitemap index capacity.",
    });
  }

  const bucketRowsByNaturalShard = new Map<string, BucketShardRow[]>();
  for (const bucketShard of bucketShardRows) {
    const shardKey = createNaturalShardKey(bucketShard);
    const storedBucketRows = bucketRowsByNaturalShard.get(shardKey);
    const bucketRows = arrayOrEmpty(storedBucketRows);
    bucketRows.push(bucketShard);
    bucketRowsByNaturalShard.set(shardKey, bucketRows);
  }

  const items: {
    bucket: string;
    country: string;
    lastmod: string | null;
    month: string;
    year: string;
  }[] = [];

  for (const shard of naturalShards) {
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

    const storedBucketRows = bucketRowsByNaturalShard.get(
      createNaturalShardKey(shard),
    );
    const bucketRows = arrayOrEmpty(storedBucketRows);
    if (bucketRows.length === 0) {
      return status(500, {
        message: "Case-law sitemap bucket rows missing for natural shard.",
      });
    }

    for (const bucketRow of bucketRows) {
      if (bucketRow.total > LIMITS.caseLawSitemapShardUrlLimit) {
        return status(500, {
          message: "Case-law sitemap bucket exceeds shard capacity.",
        });
      }

      items.push({
        bucket: bucketRow.bucket,
        country: getCountryPathSegment(shard.country),
        lastmod: getLastmod(bucketRow.lastmod),
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

  const queryResult = await caseLawDb(async (tx) => {
    const rows = await tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        slug: caseLawDecisions.slug,
        country: caseLawDecisions.country,
        court: caseLawDecisions.court,
        language: caseLawDecisions.language,
        languageGroupKey: caseLawDecisions.languageGroupKey,
        updatedAt: caseLawDecisions.updatedAt,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(and(redistributableCaseLawSource, ...conditions))
      .orderBy(desc(caseLawDecisions.updatedAt), desc(caseLawDecisions.id))
      .limit(LIMITS.caseLawSitemapShardUrlLimit + 1);

    if (rows.length > LIMITS.caseLawSitemapShardUrlLimit) {
      return { type: "capacityExceeded" as const };
    }

    const languageGroupKeys = [
      ...new Set(
        rows
          .map((row) => row.languageGroupKey)
          .filter((value): value is string => value !== null),
      ),
    ];
    const alternateRows: SitemapDecisionRow[] = [];
    // Bound rows per batch at the realistic max language variants for the up to
    // SITEMAP_LANGUAGE_ALTERNATE_GROUP_BATCH_SIZE group keys in the batch (+1 to
    // detect overflow). Without this, one languageGroupKey matching many rows
    // would make the read unbounded. Hitting the cap is a data-integrity anomaly
    // (a group exceeding the expected variant count), not a normal case: warn and
    // proceed with what loaded rather than 500 the whole sitemap.
    const alternateRowLimit =
      SITEMAP_LANGUAGE_ALTERNATE_GROUP_BATCH_SIZE *
        MAX_LANGUAGES_PER_ALTERNATE_GROUP +
      1;
    for (const groupKeyBatch of chunkArray(
      languageGroupKeys,
      SITEMAP_LANGUAGE_ALTERNATE_GROUP_BATCH_SIZE,
    )) {
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential reads on the same transaction connection (one in-flight query per tx)
      const batchRows = await tx
        .select({
          id: caseLawDecisions.id,
          caseNumber: caseLawDecisions.caseNumber,
          slug: caseLawDecisions.slug,
          country: caseLawDecisions.country,
          court: caseLawDecisions.court,
          language: caseLawDecisions.language,
          languageGroupKey: caseLawDecisions.languageGroupKey,
          updatedAt: caseLawDecisions.updatedAt,
        })
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            inArray(caseLawDecisions.languageGroupKey, groupKeyBatch),
            redistributableCaseLawSource,
          ),
        )
        .orderBy(asc(caseLawDecisions.language), asc(caseLawDecisions.id))
        .limit(alternateRowLimit);
      if (batchRows.length === alternateRowLimit) {
        logger.warn("case_law.sitemap.language_alternate_overflow", {
          country: query.country,
          year: query.year,
          month: query.month,
          bucket: query.bucket ?? SITEMAP_ALL_BUCKET,
          groupKeys: groupKeyBatch.length,
          limit: alternateRowLimit,
        });
      }
      alternateRows.push(...batchRows);
    }

    return { type: "rows" as const, rows, alternateRows };
  });

  if (queryResult.type === "capacityExceeded") {
    return status(500, {
      message: "Case-law sitemap shard exceeds sitemap URL capacity.",
    });
  }

  const { alternateRows, rows } = queryResult;
  const alternatesByGroupKey = new Map<string, SitemapDecisionAlternate[]>();
  for (const alternate of alternateRows) {
    if (alternate.languageGroupKey === null) {
      continue;
    }

    const normalizedLanguage = normalizeLanguageSegment(alternate.language);
    if (normalizedLanguage === null) {
      continue;
    }

    const storedAlternates = alternatesByGroupKey.get(
      alternate.languageGroupKey,
    );
    const groupedAlternates = arrayOrEmpty(storedAlternates);
    if (
      groupedAlternates.some(
        (groupedAlternate) =>
          normalizeLanguageSegment(groupedAlternate.language) ===
          normalizedLanguage,
      )
    ) {
      continue;
    }

    groupedAlternates.push({
      id: alternate.id,
      caseNumber: alternate.caseNumber,
      slug: alternate.slug,
      country: alternate.country,
      court: alternate.court,
      language: alternate.language,
      updatedAt: alternate.updatedAt,
    });
    alternatesByGroupKey.set(alternate.languageGroupKey, groupedAlternates);
  }

  return {
    items: rows.map((row) => {
      const storedAlternates =
        row.languageGroupKey === null
          ? undefined
          : alternatesByGroupKey.get(row.languageGroupKey);
      const alternates = arrayOrEmpty(storedAlternates);

      return {
        id: row.id,
        caseNumber: row.caseNumber,
        slug: row.slug,
        country: row.country,
        court: row.court,
        language: row.language,
        languageAlternates: alternates.length > 1 ? alternates : [],
        updatedAt: row.updatedAt,
      };
    }),
    limit: LIMITS.caseLawSitemapShardUrlLimit,
    nextCursor: null,
  };
};
