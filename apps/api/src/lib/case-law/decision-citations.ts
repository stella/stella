import { asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { status } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import type { CitationDirection } from "@/api/lib/case-law/citation-vocabulary";
import {
  canonicalRuleApplies,
  DECISION_WORK_MANIFESTATIONS_MAX,
  ownTextScope,
  workCitationStream,
} from "@/api/lib/case-law/decision-work";
import type { DecisionWork } from "@/api/lib/case-law/decision-work";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
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

const relatedDecision = alias(
  publishedCaseLawDecisions,
  "related_case_law_decision",
);
const relatedSource = alias(caseLawSources, "related_case_law_source");

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
  /** The subject's work: a page lists the citations of every version. */
  work: DecisionWork;
  /** The subject's own country list; the far end answers to the same list. */
  countries: readonly string[];
};

const pageLimit = () =>
  normalizeTenantPageLimit(LIMITS.caseLawDecisionCitationPageSize);

/**
 * Raw rows one page examines at most: see `citationPageWindowSize` in the
 * citation graph, whose rule this page follows.
 */
const windowSizeFor = (direction: CitationDirection, work: DecisionWork) =>
  canonicalRuleApplies(direction, work)
    ? (pageLimit() + 1) * DECISION_WORK_MANIFESTATIONS_MAX
    : pageLimit() + 1;

type ScannedCitation<T> = {
  item: T;
  scanId: SafeId<"caseLawCitation">;
  visible: boolean;
  canonical: boolean;
  ordinal: number;
};

/**
 * The cursor advances over every examined row, hidden or not. A row another
 * language version already holds is skipped inside the raw window; a window
 * that fills before the page does ends the page at its last row.
 */
const createScannedCitationPage = <T>(
  rows: readonly ScannedCitation<T>[],
  windowSize: number,
): Page<T> => {
  const limit = pageLimit();
  const canonical = rows.filter((row) => row.canonical);
  const scanned = canonical.slice(0, limit);
  const items: T[] = [];
  for (const row of scanned) {
    if (row.visible) {
      items.push(row.item);
    }
  }
  const lastScanned = scanned.at(-1);
  const windowEnd = rows.find((row) => row.ordinal === windowSize);
  let boundary: SafeId<"caseLawCitation"> | null = null;
  if (canonical.length > limit && lastScanned !== undefined) {
    boundary = lastScanned.scanId;
  } else if (windowEnd !== undefined) {
    boundary = windowEnd.scanId;
  }

  return {
    items,
    limit,
    nextCursor: boundary === null ? null : encodePaginationCursor([boundary]),
  };
};

const readWorkCitationRows = async (
  direction: CitationDirection,
  { tx, cursor, work, countries }: CitationPageOptions,
) => {
  const cursorId = decodeCitationCursor(cursor);
  if (cursorId === null) {
    return status(400, { message: "Invalid cursor" });
  }
  const windowSize = windowSizeFor(direction, work);
  const window = workCitationStream({
    tx,
    work,
    direction,
    after: cursorId,
    limit: windowSize,
  });
  const candidates = tx
    .select({
      id: window.id,
      citationText: window.citationText,
      relatedId: window.relatedId,
      sectionIndex: window.sectionIndex,
      ordinal: window.ordinal,
      canonical: window.canonical,
    })
    .from(window)
    .where(sql`(${window.ordinal} = ${windowSize} OR ${window.canonical})`)
    .orderBy(asc(window.id))
    .limit(pageLimit() + 1)
    .as(`${direction}_citation_candidates`);
  const rows = await tx
    .select({
      id: candidates.id,
      citationText: candidates.citationText,
      relatedId: candidates.relatedId,
      sectionIndex: candidates.sectionIndex,
      ordinal: candidates.ordinal,
      canonical: candidates.canonical,
      target: {
        decisionId: relatedDecision.id,
        caseNumber: relatedDecision.caseNumber,
        country: relatedDecision.country,
        court: relatedDecision.court,
        language: relatedDecision.language,
        languageGroupKey: relatedDecision.languageGroupKey,
        slug: relatedDecision.slug,
      },
      // An unresolved row has no far end to protect; only an outgoing row
      // can be one, since an incoming row is resolved by construction.
      visible: sql<boolean>`(
          ${candidates.relatedId} IS NULL
        OR (
          ${relatedSource.id} IS NOT NULL
          AND ${redistributableCaseLawSourceFor(relatedSource.descriptor)}
          AND ${inArray(relatedDecision.country, [...countries])}
        )
      )`,
    })
    .from(candidates)
    .leftJoin(relatedDecision, eq(relatedDecision.id, candidates.relatedId))
    .leftJoin(relatedSource, eq(relatedSource.id, relatedDecision.sourceId))
    .orderBy(asc(candidates.id))
    .limit(pageLimit() + 1);

  return { rows, windowSize };
};

const outgoingItemOf = (row: {
  id: SafeId<"caseLawCitation">;
  citationText: string;
  relatedId: SafeId<"caseLawDecision"> | null;
  sectionIndex: number | null;
}) => ({
  id: row.id,
  citationText: row.citationText,
  citedDecisionId: row.relatedId,
  sectionIndex: row.sectionIndex,
});

type OwnTextCitationPageOptions = Omit<CitationPageOptions, "work"> & {
  /** The version whose text the reader shows. */
  decisionId: SafeId<"caseLawDecision">;
};

/**
 * The outgoing citations one version's own text prints, with their routes:
 * the reader anchors each in the text it shows, so this reads that version's
 * rows only, never another version's copy of them.
 */
export const listOutgoingDecisionCitationRoutes = async ({
  decisionId,
  ...options
}: OwnTextCitationPageOptions) => {
  const read = await readWorkCitationRows("outgoing", {
    ...options,
    work: ownTextScope(decisionId),
  });
  if (!("rows" in read)) {
    return read;
  }
  const alternates = await readPublicDecisionLanguageAlternatesInTx(
    options.tx,
    read.rows
      .filter((row) => row.visible && row.canonical)
      .map((row) => row.target?.languageGroupKey ?? null),
  );
  return createScannedCitationPage(
    read.rows.map((row) => ({
      item: {
        ...outgoingItemOf(row),
        url:
          row.visible && row.target !== null
            ? buildCaseLawDecisionAppUrl({
                ...row.target,
                languageAlternates: alternates.alternatesFor(
                  row.target.languageGroupKey,
                ),
              })
            : null,
      },
      scanId: row.id,
      visible: row.visible,
      canonical: row.canonical,
      ordinal: row.ordinal,
    })),
    read.windowSize,
  );
};

export const listOutgoingDecisionCitations = async (
  options: CitationPageOptions,
) => {
  const read = await readWorkCitationRows("outgoing", options);
  if (!("rows" in read)) {
    return read;
  }
  return createScannedCitationPage(
    read.rows.map((row) => ({
      item: outgoingItemOf(row),
      scanId: row.id,
      visible: row.visible,
      canonical: row.canonical,
      ordinal: row.ordinal,
    })),
    read.windowSize,
  );
};

export const listIncomingDecisionCitations = async (
  options: CitationPageOptions,
) => {
  const read = await readWorkCitationRows("incoming", options);
  if (!("rows" in read)) {
    return read;
  }
  return createScannedCitationPage(
    read.rows.flatMap((row) =>
      // Resolved by construction: the anchor is the cited end.
      row.relatedId === null
        ? []
        : [
            {
              item: {
                id: row.id,
                citationText: row.citationText,
                citingDecisionId: row.relatedId,
                sectionIndex: row.sectionIndex,
              },
              scanId: row.id,
              visible: row.visible && row.target !== null,
              canonical: row.canonical,
              ordinal: row.ordinal,
            },
          ],
    ),
    read.windowSize,
  );
};
