/**
 * Fetch and parse the PDFs behind Slovak court decisions.
 *
 * The `sk-courts` adapter ingests metadata only. Downloading a PDF
 * costs 5-30s, and at 4.6M decisions that would dominate the crawl, so
 * a page stores what the list and detail endpoints already give it —
 * case number, ECLI, court, date — and leaves the document itself for
 * later. "Later" is here.
 *
 * A decision waiting on this is not broken, but it is not readable
 * either: no fulltext means nothing to search, nothing to cite and
 * nothing for the AI pipeline, so the queue this drains should stay
 * short rather than merely bounded.
 */

import { eq, isNull, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS, PARSER_VERSION } from "@/api/handlers/case-law/consts";
import {
  type DocumentAst,
  isDocumentAst,
} from "@/api/handlers/case-law/document-ast";
import { parseSkDecisionPdf } from "@/api/handlers/case-law/ingestion/parsers/sk-courts";
import { sanitizeResult } from "@/api/handlers/case-law/ingestion/pipeline";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import { indexDecision } from "@/api/handlers/case-law/search-index";
import type { SafeId } from "@/api/lib/branded-types";
import { fetchWithTimeout } from "@/api/lib/fetch";

/** A decision awaiting its document. */
export type PendingDocument = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  ecli: string | null;
  court: string;
  decisionDate: string | null;
  decisionType: string | null;
  documentUrl: string | null;
};

/**
 * PDFs are large and the court's site is slow; this is the timeout the
 * adapter used before the download was deferred.
 */
const PDF_TIMEOUT_MS = 30_000;

export const fetchPdfBytes = async (
  documentUrl: string,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> => {
  const response = await fetchWithTimeout(documentUrl, {
    signal,
    timeoutMs: PDF_TIMEOUT_MS,
  });
  if (!response.ok) {
    return undefined;
  }
  return new Uint8Array(await response.arrayBuffer());
};

export type BackfilledDocument = {
  fulltext: string;
  documentAst: DocumentAst;
  sections: ReturnType<typeof segmentDecision>;
};

/**
 * Parse one decision's PDF into the same shape ingestion would have
 * produced. Runs the bytes through `sanitizeResult` so a backfilled
 * row is byte-for-byte what the pipeline would have written, rather
 * than a second normalization that drifts from it.
 */
export const parsePendingDocument = async (
  pending: PendingDocument,
  pdfBytes: Uint8Array,
): Promise<BackfilledDocument | undefined> => {
  const parsed = await parseSkDecisionPdf({
    pdfBytes,
    caseNumber: pending.caseNumber,
    ecli: pending.ecli ?? undefined,
    court: pending.court,
    decisionDate: pending.decisionDate ?? undefined,
    decisionType: pending.decisionType ?? undefined,
  });

  if (parsed.documentAst.blocks.length === 0 || parsed.fulltext === "") {
    return undefined;
  }

  const sanitized = sanitizeResult({
    caseNumber: pending.caseNumber,
    court: pending.court,
    country: "SVK",
    language: "sk",
    metadata: {},
    rawHash: "",
    fulltext: parsed.fulltext,
    documentAst: parsed.documentAst,
  });

  const fulltext = sanitized.fulltext ?? "";
  // `sanitizeResult` drops an AST it cannot round-trip, so a sanitized
  // document that lost its blocks is treated as unparseable rather
  // than stored half-formed.
  if (fulltext === "" || !isDocumentAst(sanitized.documentAst)) {
    return undefined;
  }

  return {
    fulltext,
    documentAst: sanitized.documentAst,
    sections: segmentDecision(fulltext),
  };
};

/**
 * Load decisions still missing their document, oldest first so the
 * backlog drains in ingestion order rather than re-visiting the newest
 * page every run.
 */
export const loadPendingDocuments = async (
  scopedDb: ScopedDb,
  limit: number,
): Promise<PendingDocument[]> =>
  await scopedDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        ecli: caseLawDecisions.ecli,
        court: caseLawDecisions.court,
        decisionDate: caseLawDecisions.decisionDate,
        decisionType: caseLawDecisions.decisionType,
        documentUrl: caseLawDecisions.documentUrl,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawDecisions.sourceId, caseLawSources.id),
      )
      .where(
        sql`${eq(caseLawSources.adapterKey, ADAPTER_KEYS.SK_COURTS)}
          AND ${isNull(caseLawDecisions.fulltext)}
          AND ${caseLawDecisions.documentUrl} IS NOT NULL`,
      )
      .orderBy(caseLawDecisions.createdAt)
      .limit(limit),
  );

/**
 * Write a parsed document onto its decision and re-index it. Without
 * the re-index the row gains fulltext that search cannot see, which is
 * indistinguishable from the state this is fixing.
 */
export const storeBackfilledDocument = async (
  decisionId: SafeId<"caseLawDecision">,
  document: BackfilledDocument,
  scopedDb: ScopedDb,
): Promise<void> => {
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — scheduler backfill of public case-law text; no user action
    return tx
      .update(caseLawDecisions)
      .set({
        fulltext: document.fulltext,
        documentAst: document.documentAst,
        sections: document.sections.length > 0 ? document.sections : null,
        parserVersion: PARSER_VERSION,
      })
      .where(eq(caseLawDecisions.id, decisionId));
  });

  await indexDecision(decisionId, scopedDb);
};

/**
 * Mark a decision whose PDF cannot be parsed, so the queue does not
 * hand back the same failure forever. An empty string is the pipeline's
 * existing "tried and got nothing" marker, distinct from NULL.
 */
export const markDocumentUnavailable = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<void> => {
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — scheduler backfill of public case-law text; no user action
    return tx
      .update(caseLawDecisions)
      .set({ fulltext: "" })
      .where(eq(caseLawDecisions.id, decisionId));
  });
};
