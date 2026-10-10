import { and, asc, eq, gt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { status } from "elysia";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
import { publishedCaseLawDecisionFor } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution";
import { buildCaseLawDecisionAppUrl } from "@/api/lib/legal-search/public-law-app-urls";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  type Page,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
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
  tx: CaseLawPublicReadTransaction;
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
  const limit = normalizeTenantPageLimit(
    LIMITS.caseLawDecisionCitationPageSize,
  );
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

const readOutgoingDecisionCitationRows = async ({
  tx,
  cursor,
  decisionId,
}: CitationPageOptions) => {
  const cursorId = decodeCitationCursor(cursor);
  if (cursorId === null) {
    return status(400, { message: "Invalid cursor" });
  }

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
        cursorId === undefined ? undefined : gt(caseLawCitations.id, cursorId),
      ),
    )
    .orderBy(asc(caseLawCitations.id))
    .limit(normalizeTenantPageLimit(LIMITS.caseLawDecisionCitationPageSize) + 1)
    .as("outgoing_citation_candidates");
  const rows = await tx
    .select({
      item: {
        id: candidates.id,
        citationText: candidates.citationText,
        citedDecisionId: candidates.citedDecisionId,
        sectionIndex: candidates.sectionIndex,
      },
      target: {
        decisionId: citedDecision.id,
        caseNumber: citedDecision.caseNumber,
        country: citedDecision.country,
        court: citedDecision.court,
        language: citedDecision.language,
        languageGroupKey: citedDecision.languageGroupKey,
        slug: citedDecision.slug,
      },
      scanId: candidates.id,
      visible: sql<boolean>`(
          ${candidates.citedDecisionId} IS NULL
        OR (
          ${citedSource.id} IS NOT NULL
          AND ${redistributableCaseLawSourceFor(citedSource.descriptor)}
          AND ${publishedCaseLawDecisionFor(citedDecision.metadata)}
        )
      )`,
    })
    .from(candidates)
    .leftJoin(citedDecision, eq(citedDecision.id, candidates.citedDecisionId))
    .leftJoin(citedSource, eq(citedSource.id, citedDecision.sourceId))
    .orderBy(asc(candidates.id))
    .limit(
      normalizeTenantPageLimit(LIMITS.caseLawDecisionCitationPageSize) + 1,
    );

  return { rows };
};

export const listOutgoingDecisionCitationRoutes = async (
  options: CitationPageOptions,
) => {
  const read = await readOutgoingDecisionCitationRows(options);
  if (!("rows" in read)) {
    return read;
  }
  const alternates = await readPublicDecisionLanguageAlternatesInTx(
    options.tx,
    read.rows
      .filter((row) => row.visible)
      .map((row) => row.target?.languageGroupKey ?? null),
  );
  return createScannedCitationPage(
    read.rows.map(({ target, item, scanId, visible }) => ({
      item: {
        ...item,
        appUrl:
          visible && target !== null
            ? buildCaseLawDecisionAppUrl({
                ...target,
                languageAlternates: alternates.alternatesFor(
                  target.languageGroupKey,
                ),
              })
            : null,
      },
      scanId,
      visible,
    })),
  );
};

export const listOutgoingDecisionCitations = async (
  options: CitationPageOptions,
) => {
  const read = await readOutgoingDecisionCitationRows(options);
  if (!("rows" in read)) {
    return read;
  }
  return createScannedCitationPage(read.rows);
};

export const listIncomingDecisionCitations = async ({
  tx,
  cursor,
  decisionId,
}: CitationPageOptions) => {
  const cursorId = decodeCitationCursor(cursor);
  if (cursorId === null) {
    return status(400, { message: "Invalid cursor" });
  }

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
        cursorId === undefined ? undefined : gt(caseLawCitations.id, cursorId),
      ),
    )
    .orderBy(asc(caseLawCitations.id))
    .limit(normalizeTenantPageLimit(LIMITS.caseLawDecisionCitationPageSize) + 1)
    .as("incoming_citation_candidates");
  const rows = await tx
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
        AND ${publishedCaseLawDecisionFor(citingDecision.metadata)}
      )`,
    })
    .from(candidates)
    .leftJoin(
      citingDecision,
      eq(citingDecision.id, candidates.citingDecisionId),
    )
    .leftJoin(citingSource, eq(citingSource.id, citingDecision.sourceId))
    .orderBy(asc(candidates.id))
    .limit(
      normalizeTenantPageLimit(LIMITS.caseLawDecisionCitationPageSize) + 1,
    );

  return createScannedCitationPage(rows);
};
