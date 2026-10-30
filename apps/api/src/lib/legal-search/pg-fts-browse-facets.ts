import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";

import { caseLawPopulationCountsLive, caseLawSources } from "@/api/db/schema";
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

const toFacetBuckets = (
  rows: readonly { count: number; value: string }[],
): FacetBucket[] => rows.map((row) => ({ count: row.count, value: row.value }));

export const readPgFtsBrowseFacets = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawBrowseFacets,
  async (
    tx: CaseLawPublicReadTransaction,
    query: LegalBrowseFacetsQuery,
  ): Promise<LegalBrowseFacets> => {
    const scope = and(
      sql`public.assert_case_law_population_ready()`,
      redistributableCaseLawSource,
      query.jurisdiction
        ? eq(caseLawPopulationCountsLive.country, query.jurisdiction)
        : undefined,
    );

    const countryRows = await tx
      .select({
        value: caseLawPopulationCountsLive.value,
        count: sql<number>`sum(${caseLawPopulationCountsLive.total})::int`,
      })
      .from(caseLawPopulationCountsLive)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawPopulationCountsLive.sourceId),
      )
      .where(and(scope, eq(caseLawPopulationCountsLive.kind, "country")))
      .groupBy(caseLawPopulationCountsLive.value)
      .orderBy(
        desc(sql`sum(${caseLawPopulationCountsLive.total})`),
        desc(caseLawPopulationCountsLive.value),
      )
      .limit(query.limit);

    const courtRows = await tx
      .select({
        value: caseLawPopulationCountsLive.value,
        count: sql<number>`sum(${caseLawPopulationCountsLive.total})::int`,
      })
      .from(caseLawPopulationCountsLive)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawPopulationCountsLive.sourceId),
      )
      .where(and(scope, eq(caseLawPopulationCountsLive.kind, "court")))
      .groupBy(caseLawPopulationCountsLive.value)
      .orderBy(
        desc(sql`sum(${caseLawPopulationCountsLive.total})`),
        desc(caseLawPopulationCountsLive.value),
      )
      .limit(query.limit);

    const yearRows = await tx
      .select({
        value: caseLawPopulationCountsLive.value,
        count: sql<number>`sum(${caseLawPopulationCountsLive.total})::int`,
      })
      .from(caseLawPopulationCountsLive)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawPopulationCountsLive.sourceId),
      )
      .where(and(scope, eq(caseLawPopulationCountsLive.kind, "year")))
      .groupBy(caseLawPopulationCountsLive.value)
      .orderBy(desc(caseLawPopulationCountsLive.value))
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
