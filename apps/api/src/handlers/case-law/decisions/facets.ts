import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";

type FacetBucket = {
  count: number;
  value: string;
};

const toFacetBuckets = (rows: readonly FacetBucket[]): FacetBucket[] =>
  rows.map((row) => ({
    count: row.count,
    value: row.value,
  }));

export const listDecisionFacetsHandler = async (
  caseLawDb: CaseLawPublicReadDb,
) => {
  const [countryRows, courtRows, yearRows] = await caseLawDb(async (tx) => {
    const countries = await tx
      .select({
        value: caseLawDecisions.country,
        count: sql<number>`count(*)::int`,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(redistributableCaseLawSource)
      .groupBy(caseLawDecisions.country)
      .orderBy(desc(sql`count(*)`), desc(caseLawDecisions.country))
      .limit(LIMITS.caseLawFacetLimit);
    const courts = await tx
      .select({
        value: caseLawDecisions.court,
        count: sql<number>`count(*)::int`,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(redistributableCaseLawSource)
      .groupBy(caseLawDecisions.court)
      .orderBy(desc(sql`count(*)`), desc(caseLawDecisions.court))
      .limit(LIMITS.caseLawFacetLimit);
    const years = await tx
      .select({
        value: sql<string>`to_char(${caseLawDecisions.decisionDate}, 'YYYY')`,
        count: sql<number>`count(*)::int`,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          isNotNull(caseLawDecisions.decisionDate),
          redistributableCaseLawSource,
        ),
      )
      .groupBy(sql`to_char(${caseLawDecisions.decisionDate}, 'YYYY')`)
      .orderBy(desc(sql`to_char(${caseLawDecisions.decisionDate}, 'YYYY')`))
      .limit(LIMITS.caseLawFacetLimit);

    return [countries, courts, years] as const;
  });

  return {
    country: toFacetBuckets(countryRows),
    court: toFacetBuckets(courtRows),
    year: toFacetBuckets(yearRows),
  };
};
