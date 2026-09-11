import { and, asc, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  caseLawStatuteCitationCounts,
  caseLawStatuteCitationCountState,
  caseLawSources,
  STATUTE_CITATION_COUNT_STATE_KEY,
  STATUTE_CITATION_COUNT_STATUS,
  STATUTE_CITATION_TARGET_TYPE,
} from "@/api/db/schema";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";

export const statuteCitationCountsQuerySchema = t.Object({
  jurisdiction: t.String({ minLength: 2, maxLength: 3 }),
  eli: t.String({ minLength: 1, maxLength: 512 }),
});

type StatuteCitationCountsQuery = Static<
  typeof statuteCitationCountsQuerySchema
>;

/** A hard response bound; exceeding it hides counts rather than truncating. */
const PROVISION_COUNT_LIMIT = 10_000;

export const readStatuteCitationCountsHandler = async (
  query: StatuteCitationCountsQuery,
  caseLawDb: CaseLawPublicReadDb,
) =>
  await caseLawDb(async (tx) => {
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
          eq(caseLawStatuteCitationCounts.jurisdiction, query.jurisdiction),
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
