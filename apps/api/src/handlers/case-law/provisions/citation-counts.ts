import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawStatuteCitationCounts,
  caseLawStatuteCitationCountState,
  caseLawSources,
  STATUTE_CITATION_COUNT_STATE_KEY,
  STATUTE_CITATION_COUNT_STATUS,
  STATUTE_CITATION_TARGET_TYPE,
} from "@/api/db/schema";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";

export const statuteCitationCountsQuerySchema = t.Object({
  jurisdiction: tPublicLawCountry,
  eli: t.String({ minLength: 1, maxLength: 512 }),
});

type StatuteCitationCountsQuery = Static<
  typeof statuteCitationCountsQuerySchema
>;

/** A hard response bound; exceeding it hides counts rather than truncating. */
export const PROVISION_COUNT_LIMIT = 10_000;

export const readStatuteCitationCountsHandler = async (
  query: StatuteCitationCountsQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  // The filter is an equality on a stored alpha-3 code, so an unfolded
  // spelling answered an empty set rather than the counts that exist.
  const countryRead = readPublicLawCountry(query.jurisdiction, {
    admitted: PUBLIC_CASE_LAW_COUNTRIES,
    surface: "search",
    parameter: "jurisdiction",
    jurisdictionType: "provision",
  });
  if (countryRead.kind === "unavailable") {
    return countryRead.answer;
  }
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }
  const jurisdiction =
    countryRead.country === "EU"
      ? "EU"
      : publicCaseLawCountry(countryRead.country);
  if (jurisdiction === null) {
    return status(404, { message: "Not Found" });
  }
  return await caseLawDb(async (tx) => {
    if (jurisdiction === "EU") {
      // The source-level count projection cannot distinguish citing countries.
      // EU targets span countries, so count the indexed target links under the
      // same publication and country gates as the cited-by list.
      const rows = await tx
        .select({
          anchor: caseLawProvisionCitations.anchor,
          decisionCount:
            sql<number>`count(DISTINCT ${caseLawProvisionCitations.decisionId})::integer`.as(
              "decision_count",
            ),
        })
        .from(caseLawProvisionCitations)
        .innerJoin(
          caseLawDecisions,
          eq(caseLawDecisions.id, caseLawProvisionCitations.decisionId),
        )
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            eq(caseLawProvisionCitations.jurisdiction, jurisdiction),
            eq(caseLawProvisionCitations.workEli, query.eli),
            inArray(caseLawDecisions.country, PUBLIC_CASE_LAW_COUNTRIES),
            redistributableCaseLawSource,
            publishedCaseLawDecision,
          ),
        )
        .groupBy(caseLawProvisionCitations.anchor)
        .orderBy(asc(caseLawProvisionCitations.anchor))
        .limit(PROVISION_COUNT_LIMIT + 1);
      if (rows.length > PROVISION_COUNT_LIMIT) {
        return { status: "unavailable" as const };
      }
      return { status: "ready" as const, provisions: rows };
    }

    const [state] = await tx
      .select({ status: caseLawStatuteCitationCountState.status })
      .from(caseLawStatuteCitationCountState)
      .where(
        eq(
          caseLawStatuteCitationCountState.key,
          STATUTE_CITATION_COUNT_STATE_KEY,
        ),
      )
      .limit(1);

    if (state?.status !== STATUTE_CITATION_COUNT_STATUS.READY) {
      return { status: "building" as const };
    }

    const rows = await tx
      .select({
        anchor: caseLawStatuteCitationCounts.anchor,
        decisionCount:
          sql<number>`sum(${caseLawStatuteCitationCounts.decisionCount})::integer`.as(
            "decision_count",
          ),
      })
      .from(caseLawStatuteCitationCounts)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawStatuteCitationCounts.sourceId),
      )
      .where(
        and(
          eq(caseLawStatuteCitationCounts.jurisdiction, jurisdiction),
          eq(caseLawStatuteCitationCounts.workEli, query.eli),
          eq(
            caseLawStatuteCitationCounts.targetType,
            STATUTE_CITATION_TARGET_TYPE.PROVISION,
          ),
          redistributableCaseLawSource,
        ),
      )
      .groupBy(caseLawStatuteCitationCounts.anchor)
      .orderBy(asc(caseLawStatuteCitationCounts.anchor))
      .limit(PROVISION_COUNT_LIMIT + 1);

    if (rows.length > PROVISION_COUNT_LIMIT) {
      return { status: "unavailable" as const };
    }

    return { status: "ready" as const, provisions: rows };
  });
};
