/**
 * Retention projection for the competition authority's decision register.
 *
 * `sourceRaw` is an envelope of text parts: `listing`, the register view's
 * JSON row, `detail`, the register's page for the decision (a table of
 * metadata and links to the files), and for a court ruling the attachment's
 * name. The decision text itself is only ever in the attached PDFs, which the
 * pipeline stores as objects beside the envelope rather than in it. No part
 * of `sourceRaw` holds the text a parsed document was read from, so every
 * readable envelope answers that the text lives in a separate document.
 */
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

const projectPlUokik = (sourceRaw: string): RetentionProjection =>
  decodeSourceRawEnvelope(sourceRaw) === null
    ? {
        type: "unreadable",
        reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
      }
    : { type: "no-text", reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT };

export const plUokikRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) =>
    await Promise.resolve(projectPlUokik(sourceRaw)),
};
