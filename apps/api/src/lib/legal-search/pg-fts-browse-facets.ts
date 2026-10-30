import { panic, Result } from "better-result";
import { and, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

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

const sourceIsNotExcluded = (
  sourceId: AnyColumn,
  excludedSourceIds: readonly string[],
) =>
  excludedSourceIds.length === 0
    ? undefined
    : notInArray(sourceId, [...excludedSourceIds]);

/** One readiness probe and one bounded aggregate for every coverage country. */
type PgFtsBrowseFacetsBatchOptions = {
  countries: readonly string[];
  excludedSourceIds: readonly string[];
  limit: number;
};

const facetsByCountry = (
  countries: readonly string[],
  rows: readonly unknown[],
): ReadonlyMap<string, LegalBrowseFacets> => {
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
      panic("Invalid case-law browse facet row");
    }
    const facets = result.get(row["country"]);
    if (facets === undefined) {
      panic("Case-law browse facet returned an unrequested country");
    }
    if (
      row["kind"] === "country" ||
      row["kind"] === "court" ||
      row["kind"] === "year"
    ) {
      facets[row["kind"]].push({ value: row["value"], count: row["total"] });
    } else {
      panic("Invalid case-law browse facet kind");
    }
  }
  return result;
};

export const readPgFtsBrowseFacetsBatch = async (
  tx: CaseLawPublicReadTransaction,
  { countries, excludedSourceIds, limit }: PgFtsBrowseFacetsBatchOptions,
): Promise<ReadonlyMap<string, LegalBrowseFacets>> => {
  const snapshot = await tx
    .select({ kind: caseLawBrowseFacetCounts.kind })
    .from(caseLawBrowseFacetCounts)
    .orderBy(caseLawBrowseFacetCounts.kind)
    .limit(1);
  if (snapshot.length === 0) {
    const liveSourceExclusion =
      excludedSourceIds.length === 0
        ? sql`true`
        : sql`decisions.source_id NOT IN (${sql.join(
            excludedSourceIds.map((sourceId) => sql`${sourceId}`),
            sql`, `,
          )})`;
    // sql-perf-allow: bounded by the indexed published corpus during fresh-install fallback before the first materialized snapshot
    const rows = executedRows(
      await tx.execute(sql`
        WITH totals AS (
          SELECT decisions.country, 'country' AS kind,
            decisions.country AS value, count(*)::int AS total
          FROM ${publishedCaseLawDecisions} AS decisions
          INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = decisions.source_id
          WHERE decisions.country = ANY(ARRAY[${sql.join(
            countries.map((country) => sql`${country}`),
            sql`, `,
          )}]::text[])
            AND ${redistributableCaseLawSource}
            AND ${liveSourceExclusion}
          GROUP BY decisions.country
          UNION ALL
          SELECT decisions.country, 'court', decisions.court, count(*)::int
          FROM ${publishedCaseLawDecisions} AS decisions
          INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = decisions.source_id
          WHERE decisions.country = ANY(ARRAY[${sql.join(
            countries.map((country) => sql`${country}`),
            sql`, `,
          )}]::text[])
            AND decisions.court IS NOT NULL
            AND ${redistributableCaseLawSource}
            AND ${liveSourceExclusion}
          GROUP BY decisions.country, decisions.court
          UNION ALL
          SELECT decisions.country, 'year',
            to_char(decisions.decision_date, 'YYYY'), count(*)::int
          FROM ${publishedCaseLawDecisions} AS decisions
          INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = decisions.source_id
          WHERE decisions.country = ANY(ARRAY[${sql.join(
            countries.map((country) => sql`${country}`),
            sql`, `,
          )}]::text[])
            AND decisions.decision_date IS NOT NULL
            AND ${redistributableCaseLawSource}
            AND ${liveSourceExclusion}
          GROUP BY decisions.country, to_char(decisions.decision_date, 'YYYY')
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
    return facetsByCountry(countries, rows);
  }

  const sourceExclusion =
    excludedSourceIds.length === 0
      ? sql`true`
      : sql`facets.source_id NOT IN (${sql.join(
          excludedSourceIds.map((sourceId) => sql`${sourceId}`),
          sql`, `,
        )})`;

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
        AND ${sourceExclusion}
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
  return facetsByCountry(countries, rows);
};

/** Serve fresh installs before the first scheduled snapshot refresh. */
const readLivePgFtsBrowseFacets = async (
  tx: CaseLawPublicReadTransaction,
  query: LegalBrowseFacetsQuery,
): Promise<LegalBrowseFacets> => {
  const scope: SQL[] = [redistributableCaseLawSource];
  const sourceExclusion = sourceIsNotExcluded(
    publishedCaseLawDecisions.sourceId,
    query.excludedSourceIds,
  );
  if (sourceExclusion !== undefined) {
    scope.push(sourceExclusion);
  }
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
    // sql-perf-allow: bounded by the indexed published corpus during fresh-install fallback before the first materialized snapshot
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
      sourceIsNotExcluded(
        caseLawBrowseFacetCounts.sourceId,
        query.excludedSourceIds,
      ),
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
