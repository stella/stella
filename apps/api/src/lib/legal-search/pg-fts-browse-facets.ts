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
import { executedRows } from "@/api/lib/db/executed-rows";
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
import { isRecord } from "@/api/lib/type-guards";

/** Refreshed hourly, so visible bucket counts can be up to one hour stale. */

const toFacetBuckets = (
  rows: readonly { count: number; value: string }[],
): FacetBucket[] => rows.map((row) => ({ count: row.count, value: row.value }));

/** One readiness probe and one bounded aggregate for every coverage country. */
export const readPgFtsBrowseFacetsBatch = async (
  tx: CaseLawPublicReadTransaction,
  countries: readonly string[],
  limit: number,
): Promise<ReadonlyMap<string, LegalBrowseFacets>> => {
  const snapshot = await tx
    .select({ kind: caseLawBrowseFacetCounts.kind })
    .from(caseLawBrowseFacetCounts)
    .orderBy(caseLawBrowseFacetCounts.kind)
    .limit(1);
  if (snapshot.length === 0) {
    const entries: [string, LegalBrowseFacets][] = [];
    for (const country of countries) {
      // db-await-in-loop: fresh installs have no snapshot; the bounded public-country set uses the live fallback once.
      entries.push([
        country,
        await readLivePgFtsBrowseFacets(tx, {
          jurisdiction: country,
          excludedSourceIds: [],
          limit,
        }),
      ]);
    }
    return new Map(entries);
  }

  const rows = executedRows(
    await tx.execute(sql`
    WITH totals AS (
      SELECT facets.country, facets.kind, facets.value,
        sum(facets.total)::int AS total
      FROM ${caseLawBrowseFacetCounts} AS facets
      INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = facets.source_id
      WHERE facets.country = ANY(ARRAY[${sql.join(
        countries.map((country) => sql`${country}`),
        sql`, `,
      )}]::text[])
        AND ${redistributableCaseLawSource}
      GROUP BY facets.country, facets.kind, facets.value
    ), ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY country, kind
        ORDER BY CASE WHEN kind = 'year' THEN 0 ELSE total END DESC, value DESC
      ) AS position
      FROM totals
    )
    SELECT country, kind, value, total FROM ranked
    WHERE position <= ${limit}
    ORDER BY country, kind, position
  `),
  );
  const result = new Map<string, LegalBrowseFacets>();
  for (const country of countries) {
    result.set(country, { country: [], court: [], year: [] });
  }
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row["country"] !== "string" ||
      typeof row["kind"] !== "string" ||
      typeof row["value"] !== "string" ||
      typeof row["total"] !== "number"
    ) {
      continue;
    }
    const facets = result.get(row["country"]);
    if (facets === undefined) {
      continue;
    }
    if (
      row["kind"] === "country" ||
      row["kind"] === "court" ||
      row["kind"] === "year"
    ) {
      facets[row["kind"]].push({ value: row["value"], count: row["total"] });
    }
  }
  return result;
};

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
      .orderBy(caseLawBrowseFacetCounts.kind)
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
