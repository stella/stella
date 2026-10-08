import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  publicCaseLawCountry,
  PUBLIC_CASE_LAW_COUNTRIES,
} from "@stll/api-contract/case-law-launch-readiness";
import { chunk as chunkItems } from "@stll/concurrency/chunk";

import {
  caseLawDecisions,
  caseLawSitemapShards,
  caseLawSources,
} from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  decisionBucketSql,
  SITEMAP_ALL_BUCKET,
  SITEMAP_UNDATED_MONTH,
  SITEMAP_UNDATED_YEAR,
} from "@/api/lib/case-law/sitemap-shard-sql";
import { publicLawCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

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
const SITEMAP_LANGUAGE_ALTERNATE_ROW_LIMIT =
  SITEMAP_LANGUAGE_ALTERNATE_GROUP_BATCH_SIZE *
    MAX_LANGUAGES_PER_ALTERNATE_GROUP +
  1;
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

type SitemapDecisionAlternate = {
  caseNumber: string;
  country: string;
  court: string;
  id: SafeId<"caseLawDecision">;
  language: string;
  slug: string | null;
  updatedAt: Date;
};

type SitemapDecisionRow = SitemapDecisionAlternate & {
  languageGroupKey: string | null;
};

const getCountryPathSegment = (country: string): string =>
  country.toLowerCase();

const getLastmod = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

const normalizeLanguageSegment = (language: string): string | null => {
  const normalized = language.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalized || !LANGUAGE_SEGMENT_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
};

// The half-open [start, end) day range covered by one dated natural shard, so
// the shard read selects it through date bounds (and so an index) rather than
// through the `to_char` fragments the refresh groups by.
const getShardDateRange = (
  year: string,
  month: string,
): { end: string; start: string } => {
  const endMonth =
    month === "12" ? "01" : String(Number(month) + 1).padStart(2, "0");
  const endYear = month === "12" ? String(Number(year) + 1) : year;

  return { end: `${endYear}-${endMonth}-01`, start: `${year}-${month}-01` };
};

export const getShardConditions = ({
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
    const { end, start } = getShardDateRange(year, month);
    conditions.push(
      sql`${caseLawDecisions.decisionDate} >= ${start}`,
      sql`${caseLawDecisions.decisionDate} < ${end}`,
    );
  }

  if (bucket !== SITEMAP_ALL_BUCKET) {
    conditions.push(sql`${decisionBucketSql} = ${bucket}`);
  }

  return conditions;
};

export const readSitemapDecisionAlternates = async (
  tx: CaseLawPublicReadTransaction,
  languageGroupKeys: string[],
) =>
  await tx
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
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(
      and(
        inArray(caseLawDecisions.languageGroupKey, languageGroupKeys),
        inArray(caseLawDecisions.country, [...PUBLIC_CASE_LAW_COUNTRIES]),
        redistributableCaseLawSource,
        publishedCaseLawDecision,
      ),
    )
    .orderBy(asc(caseLawDecisions.language), asc(caseLawDecisions.id))
    .limit(SITEMAP_LANGUAGE_ALTERNATE_ROW_LIMIT);

export const sitemapShardDecisionsQuery = (
  tx: CaseLawPublicReadTransaction,
  conditions: readonly SQL[],
) =>
  tx
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
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(
      and(
        redistributableCaseLawSource,
        publishedCaseLawDecision,
        ...conditions,
      ),
    )
    .orderBy(desc(caseLawDecisions.updatedAt), desc(caseLawDecisions.id))
    .limit(LIMITS.caseLawSitemapShardUrlLimit + 1);

/**
 * The public sitemap index, read from the snapshot the scheduled refresh
 * writes (`lib/case-law/sitemap-shard-refresh.ts`). Counting the corpus here
 * would make every index request scan every published decision; the snapshot
 * holds one row per listed shard, and lists nothing until the first refresh.
 */
export const listSitemapShardsHandler = async (
  caseLawDb: CaseLawPublicReadDb,
) => {
  const shards = await caseLawDb(
    async (tx) =>
      await tx
        .select({
          country: caseLawSitemapShards.country,
          year: caseLawSitemapShards.year,
          month: caseLawSitemapShards.month,
          bucket: caseLawSitemapShards.bucket,
          lastModifiedAt: caseLawSitemapShards.lastModifiedAt,
        })
        .from(caseLawSitemapShards)
        .where(
          inArray(caseLawSitemapShards.country, [...PUBLIC_CASE_LAW_COUNTRIES]),
        )
        .orderBy(
          asc(caseLawSitemapShards.country),
          desc(caseLawSitemapShards.year),
          desc(caseLawSitemapShards.month),
          asc(caseLawSitemapShards.bucket),
        )
        // One past what the index can hold, so an overflow is refused rather
        // than served truncated.
        .limit(LIMITS.caseLawSitemapIndexEntryLimit),
  );

  if (shards.length > LIMITS.caseLawSitemapIndexEntryLimit - 1) {
    return status(500, {
      message: "Case-law sitemap shard count exceeds sitemap index capacity.",
    });
  }

  return {
    items: shards.map((shard) => ({
      bucket: shard.bucket,
      country: getCountryPathSegment(shard.country),
      lastmod: getLastmod(shard.lastModifiedAt),
      month: shard.month,
      year: shard.year,
    })),
    limit: LIMITS.caseLawSitemapIndexEntryLimit,
    nextCursor: null,
  };
};

export const listSitemapShardDecisionsHandler = async (
  query: SitemapShardDecisionsQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const unavailable = publicLawCountryUnavailable(query.country);
  if (unavailable !== null) {
    return unavailable;
  }
  const country = publicCaseLawCountry(query.country);
  if (country === null) {
    return status(404, { message: "Not Found" });
  }
  const scopedQuery = { ...query, country };
  const conditions = getShardConditions(scopedQuery);
  if ("error" in conditions) {
    return status(400, { message: "Invalid sitemap shard" });
  }

  const queryResult = await caseLawDb(async (tx) => {
    const rows = await sitemapShardDecisionsQuery(tx, conditions);

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
    for (const groupKeyBatch of chunkItems(
      languageGroupKeys,
      SITEMAP_LANGUAGE_ALTERNATE_GROUP_BATCH_SIZE,
    )) {
      const batchRows = await readSitemapDecisionAlternates(tx, groupKeyBatch);
      if (batchRows.length === SITEMAP_LANGUAGE_ALTERNATE_ROW_LIMIT) {
        logger.warn("case_law.sitemap.language_alternate_overflow", {
          country: scopedQuery.country,
          year: scopedQuery.year,
          month: scopedQuery.month,
          bucket: scopedQuery.bucket ?? SITEMAP_ALL_BUCKET,
          groupKeys: groupKeyBatch.length,
          limit: SITEMAP_LANGUAGE_ALTERNATE_ROW_LIMIT,
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
  const overflowedGroups = new Set<string>();
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

    if (groupedAlternates.length >= MAX_LANGUAGES_PER_ALTERNATE_GROUP) {
      if (!overflowedGroups.has(alternate.languageGroupKey)) {
        overflowedGroups.add(alternate.languageGroupKey);
        logger.warn("case_law.sitemap.language_group_overflow", {
          groupKey: alternate.languageGroupKey,
          limit: MAX_LANGUAGES_PER_ALTERNATE_GROUP,
        });
      }
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
