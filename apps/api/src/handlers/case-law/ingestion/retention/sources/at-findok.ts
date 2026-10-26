/**
 * The publisher's text of a Findok decision, read from its stored raw.
 *
 * The envelope keeps the manifest row, the archive's decision XML and, where
 * the archive carried one, its headnote XML. The decision XML wraps the
 * ministry's own XHTML, escaped, in each segment's `txt` element; the rest of
 * the XML is bookkeeping (version numbers, dates, subject codes) that no
 * reader sees as the decision. The headnote XML is a separate document whose
 * sentence the row stores as a text field, not as decision text.
 */
import * as cheerio from "cheerio";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

/** The adapter's part name for the decision XML (a module constant there). */
const DOCUMENT_XML_PART = "document-xml";

/** The body of each embedded XHTML document, in segment order. */
const embeddedBodies = (xml: string): string[] => {
  const envelope = cheerio.load(xml, { xml: true });
  return envelope("Segk > txt")
    .toArray()
    .flatMap((element) => {
      const xhtml = cheerio.load(envelope(element).text());
      const body = xhtml("body").first();
      const markup = body.html() ?? "";
      return body.text().trim() === "" ? [] : [markup];
    });
};

const projectFindokDecision = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const xml = parts[DOCUMENT_XML_PART];
  if (xml === undefined) {
    // A manifest row the archive did not supply a decision document for.
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const bodies = embeddedBodies(xml);
  if (bodies.length === 0) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  return {
    type: "source",
    source: {
      type: "paragraphs",
      paragraphs: bodies.flatMap((body) => htmlParagraphs(body)),
    },
  };
};

export const atFindokRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) =>
    await Promise.resolve(projectFindokDecision(sourceRaw)),
};
