/**
 * What rozhodnuti.justice.cz served as a regional court decision's text.
 *
 * The stored raw is an envelope of every response read for the decision; the
 * text is the `document` part, the finaldoc JSON. That payload states the
 * decision twice: as four pre-segmented paragraph sections (header, verdict,
 * justification, information) whose paragraphs are runs of text spans, and
 * as plain-text renderings of the verdict and the justification. The
 * sections are the fuller statement, so they are the text; a rendering
 * stands in only for a section the publisher left without paragraphs, which
 * is how it serves some older decisions.
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

/** The envelope part the adapter stores the finaldoc response under. */
const DOCUMENT_PART = "document";

/** One paragraph's text: its spans in order, as the publisher split them. */
const paragraphText = (paragraph: unknown): string => {
  const spans = isRecord(paragraph) ? paragraph["texts"] : undefined;
  if (!isUnknownArray(spans)) {
    return "";
  }
  return spans
    .map((span) =>
      isRecord(span) && typeof span["text"] === "string" ? span["text"] : "",
    )
    .join("")
    .trim();
};

const sectionParagraphs = (
  document: Record<string, unknown>,
  section: string,
): string[] => {
  const paragraphs = document[section];
  return isUnknownArray(paragraphs)
    ? paragraphs.map(paragraphText).filter((text) => text.length > 0)
    : [];
};

/** A section's paragraphs, or its plain-text rendering when it has none. */
const sectionOrRendering = (
  document: Record<string, unknown>,
  section: string,
  rendering: string,
): string[] => {
  const paragraphs = sectionParagraphs(document, section);
  if (paragraphs.length > 0) {
    return paragraphs;
  }
  const text = document[rendering];
  return typeof text === "string" && text.trim().length > 0
    ? [text.trim()]
    : [];
};

const projectCzRegional = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const documentRaw = parts[DOCUMENT_PART];
  if (documentRaw === undefined) {
    // A listing row alone: the publisher linked no document, or none was read.
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const document = Result.try({
    try: (): unknown => JSON.parse(documentRaw),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(document)) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const paragraphs = [
    ...sectionParagraphs(document, "header"),
    ...sectionOrRendering(document, "verdict", "verdictText"),
    ...sectionOrRendering(document, "justification", "justificationText"),
    ...sectionParagraphs(document, "information"),
  ];
  return paragraphs.length === 0
    ? { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED }
    : { type: "source", source: { type: "paragraphs", paragraphs } };
};

export const czRegionalRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) =>
    await Promise.resolve(projectCzRegional(sourceRaw)),
};
