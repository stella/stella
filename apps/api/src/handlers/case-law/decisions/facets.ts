import { desc, isNotNull, sql } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
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
  const [countryRows, courtRows, yearRows] = await Promise.all([
    caseLawDb((tx) =>
      tx
        .select({
          value: caseLawDecisions.country,
          count: sql<number>`count(*)::int`,
        })
        .from(caseLawDecisions)
        .groupBy(caseLawDecisions.country)
        .orderBy(desc(sql`count(*)`), desc(caseLawDecisions.country))
        .limit(LIMITS.caseLawFacetLimit),
    ),
    caseLawDb((tx) =>
      tx
        .select({
          value: caseLawDecisions.court,
          count: sql<number>`count(*)::int`,
        })
        .from(caseLawDecisions)
        .groupBy(caseLawDecisions.court)
        .orderBy(desc(sql`count(*)`), desc(caseLawDecisions.court))
        .limit(LIMITS.caseLawFacetLimit),
    ),
    caseLawDb((tx) =>
      tx
        .select({
          value: sql<string>`to_char(${caseLawDecisions.decisionDate}, 'YYYY')`,
          count: sql<number>`count(*)::int`,
        })
        .from(caseLawDecisions)
        .where(isNotNull(caseLawDecisions.decisionDate))
        .groupBy(sql`to_char(${caseLawDecisions.decisionDate}, 'YYYY')`)
        .orderBy(desc(sql`to_char(${caseLawDecisions.decisionDate}, 'YYYY')`))
        .limit(LIMITS.caseLawFacetLimit),
    ),
  ]);

  return {
    country: toFacetBuckets(countryRows),
    court: toFacetBuckets(courtRows),
    year: toFacetBuckets(yearRows),
  };
};
