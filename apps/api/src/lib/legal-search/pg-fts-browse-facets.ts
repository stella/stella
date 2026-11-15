import { panic, Result } from "better-result";
import { and, eq, lte, sql } from "drizzle-orm";

import {
  caseLawPublicReadDb,
  type CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { populationCountsFreshness } from "@/api/lib/case-law/population-count-freshness";
import { caseLawPopulationRows } from "@/api/lib/case-law/population-counts";
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

export const readPgFtsBrowseFacets = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawBrowseFacets,
  async (
    tx: CaseLawPublicReadTransaction,
    query: LegalBrowseFacetsQuery,
  ): Promise<LegalBrowseFacets> => {
    const population = caseLawPopulationRows(tx, query.excludedSourceIds);
    const scope = and(
      query.jurisdiction
        ? eq(population.country, query.jurisdiction)
        : undefined,
    );

    const grouped = tx
      .select({
        kind: population.kind,
        value: population.value,
        count: sql<number>`sum(${population.total})::integer`.as("count"),
      })
      .from(population)
      .where(
        and(scope, sql`${population.kind} IN ('country', 'court', 'year')`),
      )
      .groupBy(population.kind, population.value)
      .as("grouped_population");
    const ranked = tx
      .select({
        kind: grouped.kind,
        value: grouped.value,
        count: grouped.count,
        position: sql<number>`row_number() OVER (PARTITION BY ${grouped.kind}
        ORDER BY CASE WHEN ${grouped.kind} = 'year' THEN NULL ELSE ${grouped.count} END DESC,
        ${grouped.value} DESC)`.as("position"),
      })
      .from(grouped)
      .as("ranked_population");
    const bucket = (kind: "country" | "court" | "year") => sql<
      FacetBucket[]
    >`coalesce(
      jsonb_agg(jsonb_build_object('value', ${ranked.value}, 'count', ${ranked.count})
        ORDER BY ${ranked.position}) FILTER (WHERE ${ranked.kind} = ${kind}), '[]'::jsonb)`;
    const [row] = await tx
      .select({
        country: bucket("country"),
        court: bucket("court"),
        year: bucket("year"),
        countsFreshness: populationCountsFreshness,
      })
      .from(ranked)
      .where(lte(ranked.position, query.limit));
    if (!row) {
      return panic("Maintained facet aggregate returned no row");
    }
    return row;
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
