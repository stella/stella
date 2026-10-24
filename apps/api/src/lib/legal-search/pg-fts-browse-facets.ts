import { Result } from "better-result";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  caseLawBrowseFacetCounts,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import {
  caseLawPublicReadDb,
  type CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { LegalBrowseFacetsError } from "@/api/lib/legal-search/browse-facets";
import type {
  LegalBrowseFacets,
  LegalBrowseFacetsQuery,
} from "@/api/lib/legal-search/types";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";
import type { FacetBucket } from "@/api/lib/search/types";

/** Refreshed hourly, so visible bucket counts can be up to one hour stale. */

const toFacetBuckets = (
  rows: readonly { count: number; value: string }[],
): FacetBucket[] => rows.map((row) => ({ count: row.count, value: row.value }));

/** Serve fresh installs before the first scheduled snapshot refresh. */
const readLivePgFtsBrowseFacets = async (
  tx: CaseLawPublicReadTransaction,
  query: LegalBrowseFacetsQuery,
): Promise<LegalBrowseFacets> => {
  const scope: SQL[] = [redistributableCaseLawSource];
  if (query.jurisdiction) {
    scope.push(eq(publishedCaseLawDecisions.country, query.jurisdiction));
  }

  const countryRows = await tx
    .select({
      value: publishedCaseLawDecisions.country,
      count: sql<number>`count(*)::int`,
    })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(and(...scope))
    .groupBy(publishedCaseLawDecisions.country)
    .orderBy(desc(sql`count(*)`), desc(publishedCaseLawDecisions.country))
    .limit(query.limit);

  const courtRows = await tx
    .select({
      value: publishedCaseLawDecisions.court,
      count: sql<number>`count(*)::int`,
    })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(and(...scope))
    .groupBy(publishedCaseLawDecisions.court)
    .orderBy(desc(sql`count(*)`), desc(publishedCaseLawDecisions.court))
    .limit(query.limit);

  const decisionYear = sql<string>`to_char(${publishedCaseLawDecisions.decisionDate}, 'YYYY')`;
  const yearRows = await tx
    .select({
      value: decisionYear,
      count: sql<number>`count(*)::int`,
    })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(and(isNotNull(publishedCaseLawDecisions.decisionDate), ...scope))
    .groupBy(decisionYear)
    .orderBy(desc(decisionYear))
    .limit(query.limit);

  return {
    country: toFacetBuckets(countryRows),
    court: toFacetBuckets(courtRows),
    year: toFacetBuckets(yearRows),
  };
};

export const readPgFtsBrowseFacets = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawBrowseFacets,
  async (
    tx: CaseLawPublicReadTransaction,
    query: LegalBrowseFacetsQuery,
  ): Promise<LegalBrowseFacets> => {
    const snapshotRows = await tx
      .select({ kind: caseLawBrowseFacetCounts.kind })
      .from(caseLawBrowseFacetCounts)
      .limit(1);
    if (snapshotRows.length === 0) {
      return await readLivePgFtsBrowseFacets(tx, query);
    }

    const scope = and(
      redistributableCaseLawSource,
      query.jurisdiction
        ? eq(caseLawBrowseFacetCounts.country, query.jurisdiction)
        : undefined,
    );

    const countryRows = await tx
      .select({
        value: caseLawBrowseFacetCounts.value,
        count: sql<number>`sum(${caseLawBrowseFacetCounts.total})::int`,
      })
      .from(caseLawBrowseFacetCounts)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawBrowseFacetCounts.sourceId),
      )
      .where(and(scope, eq(caseLawBrowseFacetCounts.kind, "country")))
      .groupBy(caseLawBrowseFacetCounts.value)
      .orderBy(
        desc(sql`sum(${caseLawBrowseFacetCounts.total})`),
        desc(caseLawBrowseFacetCounts.value),
      )
      .limit(query.limit);

    const courtRows = await tx
      .select({
        value: caseLawBrowseFacetCounts.value,
        count: sql<number>`sum(${caseLawBrowseFacetCounts.total})::int`,
      })
      .from(caseLawBrowseFacetCounts)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawBrowseFacetCounts.sourceId),
      )
      .where(and(scope, eq(caseLawBrowseFacetCounts.kind, "court")))
      .groupBy(caseLawBrowseFacetCounts.value)
      .orderBy(
        desc(sql`sum(${caseLawBrowseFacetCounts.total})`),
        desc(caseLawBrowseFacetCounts.value),
      )
      .limit(query.limit);

    const yearRows = await tx
      .select({
        value: caseLawBrowseFacetCounts.value,
        count: sql<number>`sum(${caseLawBrowseFacetCounts.total})::int`,
      })
      .from(caseLawBrowseFacetCounts)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawBrowseFacetCounts.sourceId),
      )
      .where(and(scope, eq(caseLawBrowseFacetCounts.kind, "year")))
      .groupBy(caseLawBrowseFacetCounts.value)
      .orderBy(desc(caseLawBrowseFacetCounts.value))
      .limit(query.limit);

    return {
      country: toFacetBuckets(countryRows),
      court: toFacetBuckets(courtRows),
      year: toFacetBuckets(yearRows),
    };
  },
);

export const pgFtsBrowseFacets = async (query: LegalBrowseFacetsQuery) =>
  await Result.tryPromise({
    try: async () =>
      await caseLawPublicReadDb(
        async (tx) => await readPgFtsBrowseFacets(tx, query),
      ),
    catch: (cause) =>
      new LegalBrowseFacetsError({
        message:
          cause instanceof Error
            ? cause.message
            : "postgres browse facets failed",
        cause,
      }),
  });
