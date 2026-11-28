import { decodeSourceRawEnvelope } from "@stll/case-law-ingestion-core/source-raw-envelope";
/**
 * Retention projection for the Polish procurement appeals chamber (KIO) and
 * the court rulings on complaints its database publishes.
 *
 * The stored raw is an envelope with the listing row (`listing`), the record
 * page (`detail`) and the ruling's own document (`document`), a standalone
 * HTML document whose body is the ruling and nothing else. A document the
 * crawl refused for its size is stored as a `document-rejection` part
 * instead, and no text is parsed from it.
 */
import { load } from "@stll/html";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { plDecisionContentProjection } from "@/api/handlers/case-law/ingestion/retention/sources/pl-decision-content";

const DOCUMENT_PART = "document";

/** The converter sets a list item's numbering label as an inline box. */
const NUMBERING_LABEL = /(?:^|;)\s*display\s*:\s*inline-block/iu;

/**
 * A numbering label ("a)", "B.") is set flush against the item's text, the
 * box's width standing in for the gap. Reading the text through it must keep
 * the label a word of its own.
 */
const separateNumberingLabels = (document: string): string => {
  const $ = load(document);
  const labels = $("p > span").filter((_, span) =>
    NUMBERING_LABEL.test(span.attribs["style"] ?? ""),
  );
  if (labels.length === 0) {
    return document;
  }
  labels.after(" ");
  return $.html();
};

const projectPlKio = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const document = parts[DOCUMENT_PART];
  return document === undefined
    ? { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED }
    : plDecisionContentProjection(separateNumberingLabels(document));
};

export const plKioRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectPlKio(sourceRaw)),
};
