import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { status } from "elysia";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedCaseLawCitationId } from "@/api/lib/safe-id-boundaries";

const citedDecision = alias(caseLawDecisions, "cited_case_law_decision");
const citedSource = alias(caseLawSources, "cited_case_law_source");
const citingDecision = alias(caseLawDecisions, "citing_case_law_decision");
const citingSource = alias(caseLawSources, "citing_case_law_source");

const redistributableCitedSource = sql`(
  ${citedSource.descriptor} IS NULL
  OR (${citedSource.descriptor} ->> 'allowsRedistribution') = 'true'
)`;
const redistributableCitingSource = sql`(
  ${citingSource.descriptor} IS NULL
  OR (${citingSource.descriptor} ->> 'allowsRedistribution') = 'true'
)`;

const decodeCitationCursor = (
  cursor: string | undefined,
): SafeId<"caseLawCitation"> | null | undefined => {
  if (cursor === undefined) {
    return undefined;
  }

  const parts = decodePaginationCursor(cursor);
  const id = parts?.at(0);
  if (parts?.length !== 1 || !isUuidPaginationCursorPart(id)) {
    return null;
  }

  return brandPersistedCaseLawCitationId(id);
};

type CitationPageOptions = {
  caseLawDb: CaseLawPublicReadDb;
  cursor: string | undefined;
  decisionId: SafeId<"caseLawDecision">;
};

export const listOutgoingDecisionCitations = async ({
  caseLawDb,
  cursor,
  decisionId,
}: CitationPageOptions) => {
  const cursorId = decodeCitationCursor(cursor);
  if (cursorId === null) {
    return status(400, { message: "Invalid cursor" });
  }

  const rows = await caseLawDb((tx) =>
    tx
      .select({
        id: caseLawCitations.id,
        citationText: caseLawCitations.citationText,
        citedDecisionId: caseLawCitations.citedDecisionId,
        sectionIndex: caseLawCitations.sectionIndex,
      })
      .from(caseLawCitations)
      .leftJoin(
        citedDecision,
        eq(citedDecision.id, caseLawCitations.citedDecisionId),
      )
      .leftJoin(citedSource, eq(citedSource.id, citedDecision.sourceId))
      .where(
        and(
          eq(caseLawCitations.citingDecisionId, decisionId),
          cursorId === undefined
            ? undefined
            : gt(caseLawCitations.id, cursorId),
          or(
            isNull(caseLawCitations.citedDecisionId),
            and(isNotNull(citedSource.id), redistributableCitedSource),
          ),
        ),
      )
      .orderBy(asc(caseLawCitations.id))
      .limit(LIMITS.caseLawDecisionCitationPageSize + 1),
  );

  return createCursorPage({
    rows,
    limit: LIMITS.caseLawDecisionCitationPageSize,
    cursorForItem: (item) => encodePaginationCursor([item.id]),
  });
};

export const listIncomingDecisionCitations = async ({
  caseLawDb,
  cursor,
  decisionId,
}: CitationPageOptions) => {
  const cursorId = decodeCitationCursor(cursor);
  if (cursorId === null) {
    return status(400, { message: "Invalid cursor" });
  }

  const rows = await caseLawDb((tx) =>
    tx
      .select({
        id: caseLawCitations.id,
        citationText: caseLawCitations.citationText,
        citingDecisionId: caseLawCitations.citingDecisionId,
        sectionIndex: caseLawCitations.sectionIndex,
      })
      .from(caseLawCitations)
      .innerJoin(
        citingDecision,
        eq(citingDecision.id, caseLawCitations.citingDecisionId),
      )
      .innerJoin(citingSource, eq(citingSource.id, citingDecision.sourceId))
      .where(
        and(
          eq(caseLawCitations.citedDecisionId, decisionId),
          redistributableCitingSource,
          cursorId === undefined
            ? undefined
            : gt(caseLawCitations.id, cursorId),
        ),
      )
      .orderBy(asc(caseLawCitations.id))
      .limit(LIMITS.caseLawDecisionCitationPageSize + 1),
  );

  return createCursorPage({
    rows,
    limit: LIMITS.caseLawDecisionCitationPageSize,
    cursorForItem: (item) => encodePaginationCursor([item.id]),
  });
};
