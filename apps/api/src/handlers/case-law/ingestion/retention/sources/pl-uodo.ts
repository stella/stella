/**
 * Retention projection for the data-protection authority's portal.
 *
 * `sourceRaw` is an envelope with a `listing` part (the portal's JSON record)
 * and, for an authority decision whose body was fetched, a `body-xml` part:
 * the decision XML exactly as served. The XML holds the whole decision as
 * structured units under an `xPart` root, and every printed string sits in an
 * `xName` (a unit's marker or the decision's form), an `xTitle` (a file mark
 * or a section title) or an `xText` (a passage, a footnote). Those strings,
 * read off the XML in document order, are the publisher's text.
 *
 * Court rulings and records stored without a body carry the listing alone:
 * the portal files no text for them.
 */
import * as cheerio from "cheerio";
import { type AnyNode, isCDATA, isTag, isText } from "domhandler";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

/** The envelope part the adapter stores the decision XML under. */
const BODY_PART = "body-xml";

/** Elements whose whole text the portal prints as one string. */
const PRINTED_ELEMENTS = new Set(["xName", "xTitle", "xText"]);

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * Every printed string under the root, in order. A text node outside the
 * printed elements is kept too: the portal prints it, so a parse that drops
 * it has lost text.
 */
const printedStrings = ($: cheerio.CheerioAPI, root: AnyNode): string[] => {
  const strings: string[] = [];
  const visit = (node: AnyNode): void => {
    if (isText(node)) {
      strings.push(collapse(node.data));
      return;
    }
    if (isCDATA(node)) {
      for (const child of node.children) {
        visit(child);
      }
      return;
    }
    if (!isTag(node)) {
      return;
    }
    if (PRINTED_ELEMENTS.has(node.tagName)) {
      strings.push(collapse($(node).text()));
      return;
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return strings.filter((text) => text !== "");
};

const projectPlUodo = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const xml = parts[BODY_PART];
  if (xml === undefined) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const $ = cheerio.load(xml, { xml: true });
  const root = $("xPart").get(0);
  if (root === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  return {
    type: "source",
    source: { type: "paragraphs", paragraphs: printedStrings($, root) },
  };
};

export const plUodoRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectPlUodo(sourceRaw)),
};
