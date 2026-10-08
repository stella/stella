import { Result, TaggedError } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import {
  legislationDocuments,
  legislationFacetCounts,
  legislationFacetRefreshes,
  legislationSources,
} from "@/api/db/schema";
import {
  LEGISLATION_DOCUMENT_TYPE_BUCKET_LIMIT,
  projectLegislationFacets,
} from "@/api/handlers/legislation/catalog-response";
import { readBounded } from "@/api/lib/db/read-bounded";
import { errorTag } from "@/api/lib/errors/utils";
import { isLatestOpenedVersionOfWorkAt } from "@/api/lib/legal-search/legislation-listed-version";
import {
  publishedLegislationDocument,
  publishedLegislationProjectionFor,
} from "@/api/lib/legal-search/legislation-redistribution";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { logger } from "@/api/lib/observability/logger";

/**
 * What a statute listing can be narrowed by, for one jurisdiction: the kinds
 * of act the corpus holds and how many Works carry each. Whole-jurisdiction
 * and slow-moving, so it is read from a snapshot the scheduler refreshes.
 */

export const legislationFacetsQuerySchema = t.Object({
  country: tPublicLawCountry,
});

type LegislationFacetsQuery = Static<typeof legislationFacetsQuerySchema>;

type LegislationFacetBucket = { value: string; count: number };

export type LegislationFacets = {
  /** Works per kind of act, most common first. */
  documentType: LegislationFacetBucket[];
};

class LegislationFacetsError extends TaggedError("LegislationFacetsError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * The facets as the hourly snapshot (`legislation_facet_counts`) states them:
 * a sum over a few rows per source, so the request never walks the corpus.
 * Source policy and jurisdiction admission are applied here, at read time, so
 * a revoked source stops counting at once rather than at the next refresh.
 */
export const legislationFacetSnapshotQuery = (
  tx: LegislationReadTransaction,
  country: string,
) =>
  tx
    .select({
      value: legislationFacetCounts.documentType,
      count: sql<number>`sum(${legislationFacetCounts.works})::integer`,
    })
    .from(legislationFacetCounts)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationFacetCounts.sourceId),
    )
    .where(
      and(
        publishedLegislationProjectionFor(legislationFacetCounts.country),
        eq(legislationFacetCounts.country, country),
      ),
    )
    .groupBy(legislationFacetCounts.documentType)
    // SAFETY: the one caller reads this through `readBounded`, which applies
    // the bucket cap plus one and refuses an overflowing set.
    // oxlint-disable-next-line require-query-limit/require-query-limit -- bounded by readBounded at the call site; see SAFETY above
    .orderBy(
      sql`sum(${legislationFacetCounts.works}) DESC`,
      legislationFacetCounts.documentType,
    );

/**
 * Each Work is counted by the row the listing shows for it today
 * (`isLatestOpenedVersionOfWorkAt`), so a bucket's count is the length of the
 * list narrowed to it: a Work that only opens in the future is not offered,
 * and a Work whose kind changed between wordings counts once, under the kind
 * it is listed as.
 *
 * The answer comes from the snapshot the scheduler refreshes every hour. Only
 * a database that has never been refreshed (a fresh install, a fixture) pays
 * the live aggregation, which counts the same thing straight from the corpus.
 */
export const readLegislationFacets = async (
  legislationDb: LegislationReadDb,
  country: string,
): Promise<LegislationFacets> =>
  await legislationDb(async (tx) => {
    // The refresh marker, not the buckets: a reader that can see no bucket
    // (every source withheld) still has a snapshot, and its answer is empty.
    const refreshed = await tx
      .select({ refreshedAt: legislationFacetRefreshes.refreshedAt })
      .from(legislationFacetRefreshes)
      .limit(1);
    if (refreshed.length === 0) {
      return { documentType: await buildLegislationFacetsQuery(tx, country) };
    }
    const buckets = await readBounded(
      legislationFacetSnapshotQuery(tx, country),
      LEGISLATION_DOCUMENT_TYPE_BUCKET_LIMIT,
    );
    if (buckets.type === "overflow") {
      // More kinds of act than the response can carry: no options beats a
      // silently truncated list that reads as complete.
      logger.warn("legislation.facets.bucket_overflow", {
        country,
        cap: buckets.cap,
      });
      return { documentType: [] };
    }
    return { documentType: buckets.rows };
  });

/**
 * The live aggregation: a scan of the jurisdiction. Served only before the
 * first snapshot refresh; the refresh counts the same rows per source.
 */
export const buildLegislationFacetsQuery = (
  tx: LegislationReadTransaction,
  country: string,
) =>
  tx
    .select({
      value: sql<string>`${legislationDocuments.documentType}`,
      count: sql<number>`count(*)::integer`,
    })
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .where(
      and(
        publishedLegislationDocument,
        eq(legislationDocuments.country, country),
        isLatestOpenedVersionOfWorkAt(sql`CURRENT_DATE`),
        sql`${legislationDocuments.documentType} <> ''`,
      ),
    )
    .groupBy(legislationDocuments.documentType)
    .orderBy(sql`count(*) DESC`, legislationDocuments.documentType)
    .limit(LEGISLATION_DOCUMENT_TYPE_BUCKET_LIMIT);

const NO_FACETS: LegislationFacets = { documentType: [] };

export const readLegislationFacetsHandler = async (
  { country }: LegislationFacetsQuery,
  legislationDb: LegislationReadDb,
) => {
  const countryRead = readPublicLawCountry(country, {
    admitted: PUBLIC_LEGISLATION_COUNTRIES,
  });
  if (countryRead.kind === "unavailable") {
    return countryRead.answer;
  }
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }

  // The facets narrow a listing that works without them, so an unreadable
  // corpus degrades to no options, as the shelf does, and is logged.
  const result = await Result.tryPromise({
    try: async () =>
      await readLegislationFacets(legislationDb, countryRead.country),
    catch: (cause) =>
      new LegislationFacetsError({
        message: "Legislation facets could not be read",
        cause,
      }),
  });
  if (Result.isError(result)) {
    logger.warn("legislation.facets.unavailable", {
      "error.type": errorTag(result.error),
    });
    return NO_FACETS;
  }
  return projectLegislationFacets(result.value);
};
