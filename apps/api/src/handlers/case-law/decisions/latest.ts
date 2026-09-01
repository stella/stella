import { Result, TaggedError } from "better-result";
import { sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { readBrowseFacets } from "@/api/handlers/case-law/decisions/facets";
import { decisionDateSortKeySql } from "@/api/handlers/case-law/decisions/list";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  decisionHeadnoteSql,
  normalizeDecisionHeadnote,
} from "@/api/lib/case-law/decision-headnote";
import {
  type PublicDecisionLanguageAlternate,
  readPublicDecisionLanguageAlternatesByGroup,
} from "@/api/lib/case-law/language-alternates";
import { readNonRedistributableCaseLawSourceIds } from "@/api/lib/case-law/non-redistributable-sources";
import { redistributableCaseLawSourceSqlFor } from "@/api/lib/case-law/redistribution";
import { errorTag } from "@/api/lib/errors/utils";
import { createTtlResultCache } from "@/api/lib/legal-search/browse-facets-cache";
import { isCorpusIndexJurisdiction } from "@/api/lib/legal-search/index-naming";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/**
 * The browse page's shelf when nothing has been typed: the newest decisions
 * of the jurisdiction's largest courts, a few per court. Whole-corpus and
 * slow-moving, so it is cached the way the facets are.
 */

export const listLatestDecisionsQuerySchema = t.Object({
  country: t.String({ minLength: 2, maxLength: 3 }),
});

type ListLatestDecisionsQuery = Static<typeof listLatestDecisionsQuerySchema>;

export type LatestDecision = {
  id: string;
  caseNumber: string;
  slug: string | null;
  ecli: string | null;
  court: string;
  country: string;
  language: string;
  languageAlternates: readonly PublicDecisionLanguageAlternate[];
  decisionDate: string | null;
  decisionType: string | null;
  headnote: string | null;
  citationCount: number;
};

export type LatestDecisionsByCourt = {
  court: string;
  decisions: LatestDecision[];
};

export type LatestDecisions = {
  country: string;
  courts: LatestDecisionsByCourt[];
};

class LatestDecisionsError extends TaggedError("LatestDecisionsError")<{
  message: string;
  cause?: unknown;
}> {}

const LATEST_CACHE_TTL_MS = 5 * 60 * 1000;
const LATEST_CACHE_MAX_ENTRIES = 16;

const toNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Drivers disagree: bun-sql returns the rows, pglite wraps them in `{ rows }`. */
const rowsOf = (result: unknown): Record<string, unknown>[] => {
  let rows: unknown = result;
  if (!Array.isArray(result) && isRecord(result)) {
    rows = result["rows"];
  }
  if (!Array.isArray(rows)) {
    throw new LatestDecisionsError({
      message: "Newest decisions query returned no row set",
    });
  }
  return rows.filter(isRecord);
};

const requiredString = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") {
    throw new LatestDecisionsError({
      message: `Newest decisions row is missing ${key}`,
    });
  }
  return value;
};

type ReadLatestDecisionsByCourtOptions = {
  caseLawDb: CaseLawPublicReadDb;
  country: string;
  /** Shelf order; the corpus's largest courts first. */
  courts: readonly string[];
};

/**
 * The newest decisions of the given courts, a few per court, in the courts'
 * order. One statement for every court: the lateral walks each court's slice
 * of the date index backwards and stops after a handful of rows. A
 * multilingual decision appears once, by its oldest listable version, the
 * same rule the browse list applies.
 */
export const readLatestDecisionsByCourt = async ({
  caseLawDb,
  country,
  courts,
}: ReadLatestDecisionsByCourtOptions): Promise<LatestDecisionsByCourt[]> => {
  if (courts.length === 0) {
    return [];
  }
  const result: unknown = await caseLawDb(
    async (tx) =>
      await tx.execute(sql`
        SELECT
          d.id,
          d.case_number,
          d.slug,
          d.ecli,
          d.court,
          d.country,
          d.language,
          d.language_group_key,
          d.decision_date,
          d.decision_type,
          d.citation_count,
          ${decisionHeadnoteSql(sql.raw("d.metadata"))} AS headnote
        FROM jsonb_array_elements_text(${JSON.stringify(courts)}::text::jsonb)
          WITH ORDINALITY AS shelf(court, ordinality)
        CROSS JOIN LATERAL (
          -- Named columns, never a wildcard: the public reader role sees only
          -- the allowlisted columns, and d.* would ask for the rest.
          SELECT
            d.id,
            d.case_number,
            d.slug,
            d.ecli,
            d.court,
            d.country,
            d.language,
            d.language_group_key,
            d.decision_date,
            d.decision_type,
            d.citation_count,
            d.metadata,
            d.created_at
          FROM case_law_decisions d
          JOIN case_law_sources s
            ON s.id = d.source_id
           AND ${sql.raw(redistributableCaseLawSourceSqlFor("s"))}
          WHERE d.country = ${country}
            AND d.court = shelf.court
            AND (
              d.language_group_key IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM case_law_decisions sibling
                JOIN case_law_sources sibling_source
                  ON sibling_source.id = sibling.source_id
                 AND ${sql.raw(redistributableCaseLawSourceSqlFor("sibling_source"))}
                WHERE sibling.language_group_key = d.language_group_key
                  AND sibling.country = d.country
                  AND sibling.court = d.court
                  AND (sibling.created_at, sibling.id) < (d.created_at, d.id)
              )
            )
          ORDER BY ${decisionDateSortKeySql(sql.raw("d.decision_date"))} DESC, d.id DESC
          LIMIT ${LIMITS.caseLawLatestPerCourt}
        ) d
        ORDER BY shelf.ordinality, ${decisionDateSortKeySql(sql.raw("d.decision_date"))} DESC, d.id DESC
      `),
  );
  const rows = rowsOf(result);

  const languageGroupKeys = [
    ...new Set(
      rows
        .map((row) => toNullableString(row["language_group_key"]))
        .filter((value): value is string => value !== null),
    ),
  ];
  const alternatesByGroupKey =
    await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys,
    });

  const byCourt = new Map<string, LatestDecision[]>(
    courts.map((court) => [court, []]),
  );
  for (const row of rows) {
    const court = requiredString(row, "court");
    const decisions = byCourt.get(court);
    if (decisions === undefined) {
      throw new LatestDecisionsError({
        message: "Newest decisions row names a court outside the shelf",
      });
    }
    decisions.push({
      id: requiredString(row, "id"),
      caseNumber: requiredString(row, "case_number"),
      slug: toNullableString(row["slug"]),
      ecli: toNullableString(row["ecli"]),
      court,
      country: requiredString(row, "country"),
      language: requiredString(row, "language"),
      languageAlternates: alternatesByGroupKey.alternatesFor(
        toNullableString(row["language_group_key"]),
      ),
      decisionDate: toNullableString(row["decision_date"]),
      decisionType: toNullableString(row["decision_type"]),
      headnote: normalizeDecisionHeadnote(row["headnote"]),
      citationCount: Number(row["citation_count"]) || 0,
    });
  }

  return courts.flatMap((court) => {
    const decisions = byCourt.get(court);
    return decisions === undefined || decisions.length === 0
      ? []
      : [{ court, decisions }];
  });
};

type LatestDecisionsLoad = {
  caseLawDb: CaseLawPublicReadDb;
  country: string;
  excludedSourceIds: readonly string[];
};

const loadLatestDecisions = async ({
  caseLawDb,
  country,
}: LatestDecisionsLoad): Promise<
  Result<LatestDecisions, LatestDecisionsError>
> =>
  await Result.tryPromise({
    try: async () => {
      // The shelf's courts are the jurisdiction's largest, which the facets
      // already count (and cache).
      const facets = await readBrowseFacets(country);
      const courts = facets.court
        .slice(0, LIMITS.caseLawLatestCourts)
        .map((bucket) => bucket.value);
      return {
        country,
        courts: await readLatestDecisionsByCourt({
          caseLawDb,
          country,
          courts,
        }),
      };
    },
    catch: (cause) =>
      new LatestDecisionsError({
        message: "Newest decisions could not be read",
        cause,
      }),
  });

const latestDecisions = createTtlResultCache({
  load: loadLatestDecisions,
  // Source policy is an input to the answer, so a revocation changes the key
  // instead of waiting out the window; sorted because the set has no order.
  key: ({ country, excludedSourceIds }: LatestDecisionsLoad) =>
    `${country}:${excludedSourceIds.toSorted().join(",")}`,
  ttlMs: LATEST_CACHE_TTL_MS,
  maxEntries: LATEST_CACHE_MAX_ENTRIES,
});

export const listLatestDecisionsHandler = async (
  { country }: ListLatestDecisionsQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  if (!isCorpusIndexJurisdiction(country)) {
    return status(400, { message: "Invalid country" });
  }
  const jurisdiction = country.toUpperCase();
  const empty: LatestDecisions = { country: jurisdiction, courts: [] };

  const excludedSourceIds = await readNonRedistributableCaseLawSourceIds();
  if (Result.isError(excludedSourceIds)) {
    logger.warn("case_law.latest_decisions.unavailable", {
      "error.type": errorTag(excludedSourceIds.error),
    });
    return empty;
  }

  const result = await latestDecisions({
    caseLawDb,
    country: jurisdiction,
    excludedSourceIds: excludedSourceIds.value,
  });
  if (Result.isError(result)) {
    // The shelf is the page's empty state, not its content: without it the
    // box still resolves and searches, so degrade rather than fail.
    logger.warn("case_law.latest_decisions.unavailable", {
      "error.type": errorTag(result.error),
    });
    return empty;
  }
  return result.value;
};
