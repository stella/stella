/**
 * The publisher text of one Polish decision document, as the shared Polish
 * decision reader receives it: an HTML document or fragment, or plain text
 * with blank lines between paragraphs. Procurement rulings and tax
 * interpretations both hand their document to that reader, so both project
 * their document the same way.
 */
import * as cheerio from "cheerio";

import {
  RETENTION_TEXT_ABSENCE,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";

/** Any start tag: a document without one is plain text, not markup. */
const START_TAG = /<[a-z][^>]*>/iu;

/** Plain text separates paragraphs with a blank line. */
const plainParagraphs = (text: string): string[] =>
  text
    .split(/\r?\n(?:[ \t]*\r?\n)+/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

export const plDecisionContentProjection = (
  content: string,
): RetentionProjection => {
  if (content.trim().length === 0) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  if (!START_TAG.test(content)) {
    return {
      type: "source",
      source: { type: "paragraphs", paragraphs: plainParagraphs(content) },
    };
  }
  // The document is the decision alone, with no site navigation around it:
  // its body is the content region, and a fragment parses into a body too.
  const $ = cheerio.load(content);
  return {
    type: "source",
    source: {
      type: "paragraphs",
      paragraphs: htmlParagraphs($("body").html() ?? ""),
    },
  };
};
