/**
 * Retention projection for the Slovak Constitutional Court.
 *
 * The adapter stores every response it read for a decision in one envelope.
 * The `document` part is the XHTML the content endpoint served, already
 * decoded from the base64 the service wraps it in: the decision rendered on
 * its own, one `<div>` of spans and line breaks with no portal around it, so
 * the whole document is the decision's content region. The other parts
 * (listing, facets, docket file, vocabularies) are metadata, and the file the
 * court also serves is binary and is stored outside the envelope.
 *
 * Rows stored before the envelope hold the search row alone, or the file's
 * bytes alone; neither carries the rendered text, and neither builds a
 * document, so they never reach this check with a usable AST.
 */
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

/** The envelope part the content endpoint's XHTML is stored under. */
const DOCUMENT_PART = "document";

const projectSkUs = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const document = parts[DOCUMENT_PART];
  // The service withheld or never served the rendering: the row is the
  // listing alone, which is a decision without published text.
  if (document === undefined) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  return {
    type: "source",
    source: { type: "paragraphs", paragraphs: htmlParagraphs(document) },
    options: { wordBoundaries: "publisher-fragments" },
  };
};

export const skUsRetention = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectSkUs(sourceRaw)),
} as const satisfies RetentionPolicy;
