/**
 * What uohs.gov.cz served as an Office for the Protection of Competition
 * decision's text.
 *
 * The open-data export lists each decision with links to its documents, and
 * the text lives only in those PDFs. The stored raw is the envelope of the
 * export record and the provenance of each file; the PDF bytes are stored
 * apart, as binary objects the envelope names. So the stored raw states
 * whether the decision has a document, never its text: a decision with a
 * linked file reads as text held in a separate document, one the export
 * lists without any as text not published.
 */
import { Result } from "better-result";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

/** The envelope part the adapter stores the export record under. */
const LISTING_PART = "listing";
/** The export record's list of the decision's documents. */
const DOCUMENTS_KEY = "dokument";

const projectCzUohs = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  const listing = parts?.[LISTING_PART];
  if (listing === undefined) {
    return {
      type: "unreadable",
      reason:
        parts === null
          ? RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE
          : RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  const record = Result.try({
    try: (): unknown => JSON.parse(listing),
    catch: () => null,
  }).unwrapOr(null);
  const documents = isRecord(record) ? record[DOCUMENTS_KEY] : undefined;
  if (!isUnknownArray(documents)) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  return {
    type: "no-text",
    reason:
      documents.length === 0
        ? RETENTION_TEXT_ABSENCE.NOT_PUBLISHED
        : RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
  };
};

export const czUohsRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectCzUohs(sourceRaw)),
};
