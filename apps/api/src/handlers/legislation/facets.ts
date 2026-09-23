import { Result, TaggedError } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { isLatestOpenedVersionOfWorkAt } from "@/api/handlers/legislation/list";
import { readNonRedistributableLegislationSourceIds } from "@/api/handlers/legislation/non-redistributable-sources";
import { errorTag } from "@/api/lib/errors/utils";
import { createTtlResultCache } from "@/api/lib/legal-search/browse-facets-cache";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { logger } from "@/api/lib/observability/logger";

/**
 * What a statute listing can be narrowed by, for one jurisdiction: the kinds
 * of act the corpus holds and how many Works carry each. Whole-jurisdiction
 * and slow-moving, so it is cached like the shelf.
 */

export const legislationFacetsQuerySchema = t.Object({
  country: tPublicLawCountry,
});

type LegislationFacetsQuery = Static<typeof legislationFacetsQuerySchema>;

export type LegislationFacetBucket = { value: string; count: number };

export type LegislationFacets = {
  /** Works per kind of act, most common first. */
  documentType: LegislationFacetBucket[];
};

class LegislationFacetsError extends TaggedError("LegislationFacetsError")<{
  message: string;
  cause?: unknown;
}> {}

const FACETS_CACHE_TTL_MS = 5 * 60 * 1000;
const FACETS_CACHE_MAX_ENTRIES = 16;

/**
 * The publishers' vocabulary of act kinds is small (about 400 spellings in
 * each of the Czech and Slovak corpora, most of them historical), so the cap
 * only guards against a feed that writes free text into the column.
 */
const DOCUMENT_TYPE_BUCKET_LIMIT = 1000;

/**
 * Each Work is counted by the row the listing shows for it today
 * (`isLatestOpenedVersionOfWorkAt`), so a bucket's count is the length of the
 * list narrowed to it: a Work that only opens in the future is not offered,
 * and a Work whose kind changed between wordings counts once, under the kind
 * it is listed as. The read is a scan of the jurisdiction, which the cache
 * below pays once per window.
 */
export const readLegislationFacets = async (
  legislationDb: LegislationReadDb,
  country: string,
): Promise<LegislationFacets> =>
  await legislationDb(async (tx) => {
    const documentType = await tx
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
      .limit(DOCUMENT_TYPE_BUCKET_LIMIT);

    return { documentType };
  });

type LegislationFacetsLoad = {
  legislationDb: LegislationReadDb;
  country: string;
  excludedSourceIds: readonly string[];
};

const legislationFacets = createTtlResultCache({
  load: async ({ legislationDb, country }: LegislationFacetsLoad) =>
    await Result.tryPromise({
      try: async () => await readLegislationFacets(legislationDb, country),
      catch: (cause) =>
        new LegislationFacetsError({
          message: "Legislation facets could not be read",
          cause,
        }),
    }),
  // Source policy is an input to the answer, so a revocation changes the key
  // instead of waiting out the window; sorted because the set has no order.
  key: ({ country, excludedSourceIds }: LegislationFacetsLoad) =>
    `${country}:${excludedSourceIds.toSorted().join(",")}`,
  ttlMs: FACETS_CACHE_TTL_MS,
  maxEntries: FACETS_CACHE_MAX_ENTRIES,
});

const NO_FACETS: LegislationFacets = { documentType: [] };

export const readLegislationFacetsHandler = async (
  { country }: LegislationFacetsQuery,
  legislationDb: LegislationReadDb,
) => {
  const countryRead = readPublicLawCountry(country, {
    admitted: PUBLIC_LEGISLATION_COUNTRIES,
  });
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }

  // The facets narrow a listing that works without them, so an unreadable
  // corpus degrades to no options, as the shelf does, and is logged.
  const excludedSourceIds = await readNonRedistributableLegislationSourceIds();
  if (Result.isError(excludedSourceIds)) {
    logger.warn("legislation.facets.unavailable", {
      "error.type": errorTag(excludedSourceIds.error),
    });
    return NO_FACETS;
  }

  const result = await legislationFacets({
    legislationDb,
    country: countryRead.country,
    excludedSourceIds: excludedSourceIds.value,
  });
  if (Result.isError(result)) {
    logger.warn("legislation.facets.unavailable", {
      "error.type": errorTag(result.error),
    });
    return NO_FACETS;
  }
  return result.value;
};
