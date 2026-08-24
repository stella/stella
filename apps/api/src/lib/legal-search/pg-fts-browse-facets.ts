import { Result } from "better-result";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
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

/**
 * Browse-page facets for a deployment without a corpus index: three grouped
 * scans of `case_law_decisions`. This is the self-host path and the reason the
 * capability is provider-dispatched rather than corpus-index-only. It is slow
 * on a large corpus (the aggregation path exists because of that), so the
 * caller is expected to keep it behind its TTL cache.
 */

const decisionYear = sql<string>`to_char(${caseLawDecisions.decisionDate}, 'YYYY')`;

const toFacetBuckets = (
  rows: readonly { count: number; value: string }[],
): FacetBucket[] => rows.map((row) => ({ count: row.count, value: row.value }));

export const readPgFtsBrowseFacets = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawBrowseFacets,
  async (
    tx: CaseLawPublicReadTransaction,
    query: LegalBrowseFacetsQuery,
  ): Promise<LegalBrowseFacets> => {
    const scope: SQL[] = [redistributableCaseLawSource];
    if (query.jurisdiction) {
      scope.push(eq(caseLawDecisions.country, query.jurisdiction));
    }

    const countryRows = await tx
      .select({
        value: caseLawDecisions.country,
        count: sql<number>`count(*)::int`,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(and(...scope))
      .groupBy(caseLawDecisions.country)
      .orderBy(desc(sql`count(*)`), desc(caseLawDecisions.country))
      .limit(query.limit);

    const courtRows = await tx
      .select({
        value: caseLawDecisions.court,
        count: sql<number>`count(*)::int`,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(and(...scope))
      .groupBy(caseLawDecisions.court)
      .orderBy(desc(sql`count(*)`), desc(caseLawDecisions.court))
      .limit(query.limit);

    const yearRows = await tx
      .select({
        value: decisionYear,
        count: sql<number>`count(*)::int`,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(and(isNotNull(caseLawDecisions.decisionDate), ...scope))
      .groupBy(decisionYear)
      .orderBy(desc(decisionYear))
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
