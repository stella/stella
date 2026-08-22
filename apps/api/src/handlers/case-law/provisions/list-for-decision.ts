import { and, asc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { caseLawProvisionCitations } from "@/api/db/schema";
import type { RedistributableDecisionSubject } from "@/api/handlers/case-law/decisions/public-subject";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

export const listDecisionProvisionsQuerySchema = t.Object({
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
});

type ListDecisionProvisionsQuery = Static<
  typeof listDecisionProvisionsQuerySchema
>;

type ListDecisionProvisionsOptions = {
  /**
   * Gated upstream, and the only database handle this read gets: its rows
   * come from the transaction that approved it.
   */
  subject: RedistributableDecisionSubject;
  query: ListDecisionProvisionsQuery;
};

type ProvisionCursor = { spanStart: number; anchor: string };

const decodeProvisionCursor = (cursor: string): ProvisionCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 2) {
    return null;
  }

  const [spanStart, anchor] = parts;
  if (
    typeof spanStart !== "number" ||
    !Number.isInteger(spanStart) ||
    typeof anchor !== "string"
  ) {
    return null;
  }

  return { spanStart, anchor };
};

export const listDecisionProvisionsHandler = async ({
  subject: { id: decisionId, tx },
  query,
}: ListDecisionProvisionsOptions) => {
  const limit = query.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  // Redistribution was decided when the subject was resolved; the rows
  // belong to that one decision, so no source join is needed here.
  const conditions: SQL[] = [
    eq(caseLawProvisionCitations.decisionId, decisionId),
  ];

  if (query.cursor) {
    const cursor = decodeProvisionCursor(query.cursor);
    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }

    conditions.push(
      sql`(${caseLawProvisionCitations.spanStart}, ${caseLawProvisionCitations.anchor}) > (${cursor.spanStart}::integer, ${cursor.anchor}::text)`,
    );
  }

  const rows = await tx
    .select({
      jurisdiction: caseLawProvisionCitations.jurisdiction,
      workIdentifier: caseLawProvisionCitations.workIdentifier,
      workNumber: caseLawProvisionCitations.workNumber,
      workYear: caseLawProvisionCitations.workYear,
      workCollection: caseLawProvisionCitations.workCollection,
      workEli: caseLawProvisionCitations.workEli,
      workSource: caseLawProvisionCitations.workSource,
      unit: caseLawProvisionCitations.unit,
      section: caseLawProvisionCitations.section,
      sectionSuffix: caseLawProvisionCitations.sectionSuffix,
      subsection: caseLawProvisionCitations.subsection,
      letter: caseLawProvisionCitations.letter,
      point: caseLawProvisionCitations.point,
      sentence: caseLawProvisionCitations.sentence,
      openEnded: caseLawProvisionCitations.openEnded,
      anchor: caseLawProvisionCitations.anchor,
      versionValidFrom: caseLawProvisionCitations.versionValidFrom,
      sentenceText: caseLawProvisionCitations.sentenceText,
      spanStart: caseLawProvisionCitations.spanStart,
      spanEnd: caseLawProvisionCitations.spanEnd,
      confidence: caseLawProvisionCitations.confidence,
    })
    .from(caseLawProvisionCitations)
    .where(and(...conditions))
    .orderBy(
      asc(caseLawProvisionCitations.spanStart),
      asc(caseLawProvisionCitations.anchor),
    )
    .limit(limit + 1);

  return createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([item.spanStart, item.anchor]),
  });
};
