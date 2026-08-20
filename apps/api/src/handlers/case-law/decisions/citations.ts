import { and, asc, eq, gt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { status } from "elysia";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  type Page,
} from "@/api/lib/pagination";
import { brandPersistedCaseLawCitationId } from "@/api/lib/safe-id-boundaries";

const citedDecision = alias(caseLawDecisions, "cited_case_law_decision");
const citedSource = alias(caseLawSources, "cited_case_law_source");
const citingDecision = alias(caseLawDecisions, "citing_case_law_decision");
const citingSource = alias(caseLawSources, "citing_case_law_source");

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

type ScannedCitation<T> = {
  item: T;
  scanId: SafeId<"caseLawCitation">;
  visible: boolean;
};

const createScannedCitationPage = <T>(
  rows: readonly ScannedCitation<T>[],
): Page<T> => {
  const limit = LIMITS.caseLawDecisionCitationPageSize;
  const scanned = rows.slice(0, limit);
  const items: T[] = [];
  for (const row of scanned) {
    if (row.visible) {
      items.push(row.item);
    }
  }
  const lastScanned = scanned.at(-1);

  return {
    items,
    limit,
    nextCursor:
      rows.length > limit && lastScanned !== undefined
        ? encodePaginationCursor([lastScanned.scanId])
        : null,
  };
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

  const rows = await caseLawDb((tx) => {
    const candidates = tx
      .select({
        id: caseLawCitations.id,
        citationText: caseLawCitations.citationText,
        citedDecisionId: caseLawCitations.citedDecisionId,
        sectionIndex: caseLawCitations.sectionIndex,
      })
      .from(caseLawCitations)
      .where(
        and(
          eq(caseLawCitations.citingDecisionId, decisionId),
          cursorId === undefined
            ? undefined
            : gt(caseLawCitations.id, cursorId),
        ),
      )
      .orderBy(asc(caseLawCitations.id))
      .limit(LIMITS.caseLawDecisionCitationPageSize + 1)
      .as("outgoing_citation_candidates");

    return tx
      .select({
        item: {
          id: candidates.id,
          citationText: candidates.citationText,
          citedDecisionId: candidates.citedDecisionId,
          sectionIndex: candidates.sectionIndex,
        },
        scanId: candidates.id,
        visible: sql<boolean>`(
            ${candidates.citedDecisionId} IS NULL
          OR (
            ${citedSource.id} IS NOT NULL
            AND ${redistributableCaseLawSourceFor(citedSource.descriptor)}
          )
        )`,
      })
      .from(candidates)
      .leftJoin(citedDecision, eq(citedDecision.id, candidates.citedDecisionId))
      .leftJoin(citedSource, eq(citedSource.id, citedDecision.sourceId))
      .orderBy(asc(candidates.id))
      .limit(LIMITS.caseLawDecisionCitationPageSize + 1);
  });

  return createScannedCitationPage(rows);
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

  const rows = await caseLawDb((tx) => {
    const candidates = tx
      .select({
        id: caseLawCitations.id,
        citationText: caseLawCitations.citationText,
        citingDecisionId: caseLawCitations.citingDecisionId,
        sectionIndex: caseLawCitations.sectionIndex,
      })
      .from(caseLawCitations)
      .where(
        and(
          eq(caseLawCitations.citedDecisionId, decisionId),
          cursorId === undefined
            ? undefined
            : gt(caseLawCitations.id, cursorId),
        ),
      )
      .orderBy(asc(caseLawCitations.id))
      .limit(LIMITS.caseLawDecisionCitationPageSize + 1)
      .as("incoming_citation_candidates");

    return tx
      .select({
        item: {
          id: candidates.id,
          citationText: candidates.citationText,
          citingDecisionId: candidates.citingDecisionId,
          sectionIndex: candidates.sectionIndex,
        },
        scanId: candidates.id,
        visible: sql<boolean>`(
          ${citingSource.id} IS NOT NULL
          AND ${redistributableCaseLawSourceFor(citingSource.descriptor)}
        )`,
      })
      .from(candidates)
      .leftJoin(
        citingDecision,
        eq(citingDecision.id, candidates.citingDecisionId),
      )
      .leftJoin(citingSource, eq(citingSource.id, citingDecision.sourceId))
      .orderBy(asc(candidates.id))
      .limit(LIMITS.caseLawDecisionCitationPageSize + 1);
  });

  return createScannedCitationPage(rows);
};
