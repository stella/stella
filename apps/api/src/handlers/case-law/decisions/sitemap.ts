import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import {
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
  publicCaseLawPageCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { classifyFailure } from "@stll/errors";

import {
  caseLawSitemapShards,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { status } from "@/api/http/status";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadUnderSchemaLane } from "@/api/lib/case-law-public-read-db";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { decisionDateSortKeySql } from "@/api/lib/case-law/decision-date-order";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { SITEMAP_RANGE_ROWS_CEILING } from "@/api/lib/case-law/sitemap-shard-budget";
import {
  SITEMAP_ALL_BUCKET,
  SITEMAP_BUCKET_PATTERN,
  SITEMAP_UNDATED_MONTH,
  SITEMAP_UNDATED_YEAR,
  sitemapDocumentRepresentativeFor,
  sitemapHasLanguageAlternatesFor,
  sitemapRangeConditionsFor,
} from "@/api/lib/case-law/sitemap-shard-sql";
import type { SitemapRange } from "@/api/lib/case-law/sitemap-shard-sql";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { publicLawCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observedStatus } from "@/api/lib/observability/server-error-answer";

const SITEMAP_COUNTRY_PATTERN = "^[a-z]{2,3}$";
const SITEMAP_YEAR_PATTERN = "^(?:\\d{4}|undated)$";
const SITEMAP_MONTH_PATTERN = "^(?:0[1-9]|1[0-2]|00)$";
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

const SITEMAP_CAPACITY_EXCEEDED = failureSink({
  event: "case_law.sitemap_capacity_exceeded",
  expected: [],
});

/**
 * A sitemap that would outgrow what one read may serve is refused rather than
 * served truncated: the answer could not be built within its own contract.
 */
const capacityExceeded = (message: string) =>
  observedStatus(
    {
      sink: SITEMAP_CAPACITY_EXCEEDED,
      cause: classifyFailure(
        new HandlerError({ status: 500, message }),
        "response_invalid",
      ),
    },
    500,
    { message },
  );

export const sitemapShardDecisionsQuerySchema = v.object({
  country: v.pipe(
    v.string(),
    v.regex(new RegExp(SITEMAP_COUNTRY_PATTERN, "u")),
  ),
  year: v.pipe(v.string(), v.regex(new RegExp(SITEMAP_YEAR_PATTERN, "u"))),
  month: v.pipe(v.string(), v.regex(new RegExp(SITEMAP_MONTH_PATTERN, "u"))),
  bucket: v.optional(
    v.pipe(v.string(), v.regex(new RegExp(SITEMAP_BUCKET_PATTERN, "u"))),
  ),
});

type SitemapShardDecisionsQuery = v.InferOutput<
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

// The half-open [start, end) day range covered by one dated month.
const getShardDateRange = (
  year: string,
  month: string,
): { end: string; start: string } => {
  const endMonth =
    month === "12" ? "01" : String(Number(month) + 1).padStart(2, "0");
  const endYear = month === "12" ? String(Number(year) + 1) : year;

  return { end: `${endYear}-${endMonth}-01`, start: `${year}-${month}-01` };
};

/**
 * A month's decisions, stated on the key of
 * `case_law_decisions_country_date_published_idx` so the month is one range of
 * it: the dated month a half-open day range, the undated one `-infinity`.
 */
export const getShardConditions = ({
  country,
  month,
  year,
}: Omit<SitemapShardDecisionsQuery, "bucket">):
  SQL[] | { error: "invalidShard" } => {
  const key = decisionDateSortKeySql(publishedCaseLawDecisions.decisionDate);
  const conditions: SQL[] = [
    eq(publishedCaseLawDecisions.country, country.toUpperCase()),
  ];

  if (year === SITEMAP_UNDATED_YEAR || month === SITEMAP_UNDATED_MONTH) {
    if (year !== SITEMAP_UNDATED_YEAR || month !== SITEMAP_UNDATED_MONTH) {
      return { error: "invalidShard" };
    }
    conditions.push(sql`${key} = '-infinity'::date`);
  } else {
    const { end, start } = getShardDateRange(year, month);
    conditions.push(sql`${key} >= ${start}::date`, sql`${key} < ${end}::date`);
  }

  return conditions;
};

export const readSitemapDecisionAlternates = async (
  tx: CaseLawPublicReadTransaction,
  languageGroupKeys: string[],
) =>
  await tx
    .select({
      id: publishedCaseLawDecisions.id,
      caseNumber: publishedCaseLawDecisions.caseNumber,
      slug: publishedCaseLawDecisions.slug,
      country: publishedCaseLawDecisions.country,
      court: publishedCaseLawDecisions.court,
      language: publishedCaseLawDecisions.language,
      languageGroupKey: publishedCaseLawDecisions.languageGroupKey,
      updatedAt: publishedCaseLawDecisions.updatedAt,
    })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(
      and(
        inArray(publishedCaseLawDecisions.languageGroupKey, languageGroupKeys),
        inArray(publishedCaseLawDecisions.country, [
          ...PUBLIC_CASE_LAW_PAGE_COUNTRIES,
        ]),
        redistributableCaseLawSource,
      ),
    )
    .orderBy(
      asc(publishedCaseLawDecisions.language),
      asc(publishedCaseLawDecisions.id),
    )
    .limit(SITEMAP_LANGUAGE_ALTERNATE_ROW_LIMIT);

/**
 * One shard's URLs: the listed decisions of one range of the month, in the
 * order of `case_law_decisions_country_date_published_idx`. The range is one
 * contiguous range of that index, so the read scans the range's own decisions
 * and stops one past the ceiling a file may serve, whatever the month holds.
 */
export const sitemapShardDecisionsQuery = (
  tx: CaseLawPublicReadTransaction,
  conditions: readonly SQL[],
  range: SitemapRange,
) =>
  tx
    .select({
      id: publishedCaseLawDecisions.id,
      caseNumber: publishedCaseLawDecisions.caseNumber,
      slug: publishedCaseLawDecisions.slug,
      country: publishedCaseLawDecisions.country,
      court: publishedCaseLawDecisions.court,
      language: publishedCaseLawDecisions.language,
      languageGroupKey: publishedCaseLawDecisions.languageGroupKey,
      hasLanguageAlternates: sitemapHasLanguageAlternatesFor(
        publishedCaseLawDecisions,
      ),
      updatedAt: publishedCaseLawDecisions.updatedAt,
    })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(
      and(
        ...conditions,
        ...sitemapRangeConditionsFor(publishedCaseLawDecisions, range),
        redistributableCaseLawSource,
        sitemapDocumentRepresentativeFor(publishedCaseLawDecisions),
      ),
    )
    .orderBy(
      asc(decisionDateSortKeySql(publishedCaseLawDecisions.decisionDate)),
      asc(publishedCaseLawDecisions.id),
    )
    .limit(SITEMAP_RANGE_ROWS_CEILING + 1);

const rangeKey = (
  date: string | null,
  id: string | null,
): SitemapRange["start"] =>
  date === null || id === null ? null : { date, id };

/** The listed shard a file names, with its range and size. */
const readListedShard = async (
  tx: CaseLawPublicReadTransaction,
  { bucket, country, month, year }: Required<SitemapShardDecisionsQuery>,
) =>
  (
    await tx
      .select({
        total: caseLawSitemapShards.total,
        rangeStartDate: caseLawSitemapShards.rangeStartDate,
        rangeStartId: caseLawSitemapShards.rangeStartId,
        rangeEndDate: caseLawSitemapShards.rangeEndDate,
        rangeEndId: caseLawSitemapShards.rangeEndId,
      })
      .from(caseLawSitemapShards)
      .where(
        and(
          eq(caseLawSitemapShards.country, country.toUpperCase()),
          eq(caseLawSitemapShards.year, year),
          eq(caseLawSitemapShards.month, month),
          eq(caseLawSitemapShards.bucket, bucket),
        ),
      )
      .limit(1)
  ).at(0);

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
          inArray(caseLawSitemapShards.country, [
            ...PUBLIC_CASE_LAW_PAGE_COUNTRIES,
          ]),
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
    return capacityExceeded(
      "Case-law sitemap shard count exceeds sitemap index capacity.",
    );
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
  lane: Parameters<typeof caseLawPublicReadUnderSchemaLane>[2] = {},
) => {
  const unavailable = publicLawCountryUnavailable(query.country, {
    domain: "caseLaw",
    surface: "pages",
  });
  if (unavailable !== null) {
    return unavailable;
  }
  const country = publicCaseLawPageCountry(query.country);
  if (country === null) {
    return status(404, { message: "Not Found" });
  }
  const scopedQuery = { ...query, country };
  const conditions = getShardConditions(scopedQuery);
  if ("error" in conditions) {
    return status(400, { message: "Invalid sitemap shard" });
  }

  // A shard read can still take seconds on a cold cache, while crawlers keep
  // one in flight almost always: it holds the corpus schema lane so a schema
  // upgrade drains it rather than queueing its DDL behind it. While an
  // upgrade holds the lane this rejects, and the route
  // (`tryCaseLawPublicRead`) answers a retryable 503 and Retry-After.
  const queryResult = await caseLawPublicReadUnderSchemaLane(
    caseLawDb,
    async (tx) => {
      const shard = await readListedShard(tx, {
        ...scopedQuery,
        bucket: scopedQuery.bucket ?? SITEMAP_ALL_BUCKET,
      });
      if (shard === undefined) {
        return { type: "notListed" as const };
      }
      // A range that grew past what one read may serve since its month was
      // last cut is refused before it is read; its recount cuts it again.
      if (shard.total > SITEMAP_RANGE_ROWS_CEILING) {
        return { type: "capacityExceeded" as const };
      }
      const rows = await sitemapShardDecisionsQuery(tx, conditions, {
        start: rangeKey(shard.rangeStartDate, shard.rangeStartId),
        end: rangeKey(shard.rangeEndDate, shard.rangeEndId),
      });
      if (rows.length > SITEMAP_RANGE_ROWS_CEILING) {
        return { type: "capacityExceeded" as const };
      }

      const languageGroupKeys = [
        ...new Set(
          rows
            .filter((row) => row.hasLanguageAlternates)
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
        const batchRows = await readSitemapDecisionAlternates(
          tx,
          groupKeyBatch,
        );
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
    },
    lane,
  );

  if (queryResult.type === "notListed") {
    return status(404, { message: "Not Found" });
  }
  if (queryResult.type === "capacityExceeded") {
    return capacityExceeded(
      "Case-law sitemap shard exceeds sitemap URL capacity.",
    );
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
