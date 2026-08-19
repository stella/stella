import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSources,
} from "@/api/db/schema";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";

export const listCitingDecisionsQuerySchema = t.Object({
  jurisdiction: t.String({ minLength: 2, maxLength: 3 }),
  work: t.String({ minLength: 1, maxLength: 256 }),
  anchor: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
});

type ListCitingDecisionsQuery = Static<typeof listCitingDecisionsQuerySchema>;

/** A null date sorts last under the shared descending order. */
const DECISION_DATE_FLOOR = "0001-01-01";

/**
 * Newest application first. The order is the keyset, so every key must be
 * immutable for the life of a cursor: authority is refreshed in place by the
 * citation sweep and stays out of it (it is still returned for display).
 * Rendered as ISO text explicitly, so the cursor does not depend on the
 * server's DateStyle.
 */
const decisionDateCursorSql = sql<string>`to_char(coalesce(${caseLawDecisions.decisionDate}, ${DECISION_DATE_FLOOR}::date), 'YYYY-MM-DD')`;

type CitingDecisionsCursor = {
  decisionDate: string;
  decisionId: string;
  spanStart: number;
  anchor: string;
};

const decodeCitingDecisionsCursor = (
  cursor: string,
): CitingDecisionsCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 4) {
    return null;
  }

  const [decisionDate, decisionId, spanStart, anchor] = parts;
  if (
    !isDateOnlyPaginationCursorPart(decisionDate) ||
    !isUuidPaginationCursorPart(decisionId) ||
    typeof spanStart !== "number" ||
    !Number.isInteger(spanStart) ||
    typeof anchor !== "string"
  ) {
    return null;
  }

  return { decisionDate, decisionId, spanStart, anchor };
};

export const listCitingDecisionsHandler = async (
  query: ListCitingDecisionsQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const limit = query.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const conditions: SQL[] = [
    eq(caseLawProvisionCitations.jurisdiction, query.jurisdiction),
    eq(caseLawProvisionCitations.workIdentifier, query.work),
    redistributableCaseLawSource,
  ];

  if (query.anchor !== undefined) {
    conditions.push(eq(caseLawProvisionCitations.anchor, query.anchor));
  }

  if (query.cursor) {
    const cursor = decodeCitingDecisionsCursor(query.cursor);
    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }

    conditions.push(
      sql`(
        ${decisionDateCursorSql},
        ${caseLawProvisionCitations.decisionId},
        ${caseLawProvisionCitations.spanStart},
        ${caseLawProvisionCitations.anchor}
      ) < (
        ${cursor.decisionDate}::text,
        ${cursor.decisionId}::uuid,
        ${cursor.spanStart}::integer,
        ${cursor.anchor}::text
      )`,
    );
  }

  const rows = await caseLawDb((tx) =>
    tx
      .select({
        decisionId: caseLawProvisionCitations.decisionId,
        caseNumber: caseLawDecisions.caseNumber,
        court: caseLawDecisions.court,
        country: caseLawDecisions.country,
        decisionDate: caseLawDecisions.decisionDate,
        citationAuthority: caseLawDecisions.citationAuthority,
        sentenceText: caseLawProvisionCitations.sentenceText,
        spanStart: caseLawProvisionCitations.spanStart,
        spanEnd: caseLawProvisionCitations.spanEnd,
        anchor: caseLawProvisionCitations.anchor,
        decisionDateCursor: decisionDateCursorSql.as("decision_date_cursor"),
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
      .where(and(...conditions))
      .orderBy(
        desc(decisionDateCursorSql),
        desc(caseLawProvisionCitations.decisionId),
        desc(caseLawProvisionCitations.spanStart),
        desc(caseLawProvisionCitations.anchor),
      )
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([
        item.decisionDateCursor,
        item.decisionId,
        item.spanStart,
        item.anchor,
      ]),
  });

  return {
    ...page,
    items: page.items.map(
      ({ anchor: _anchor, decisionDateCursor: _decisionDateCursor, ...item }) =>
        item,
    ),
  };
};
