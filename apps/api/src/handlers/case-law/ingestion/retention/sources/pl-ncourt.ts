/**
 * What the common courts' judgments API served for one judgment.
 *
 * The stored raw is an envelope whose `document` part is the court's own
 * XML from `/judgement/content`: an `xPart` root holding units (`xUnit`),
 * paragraphs (`xText`), titles (`xTitle`) and unit names (`xName`), with
 * inline marks inside them. The `listing` and `detail` parts are the
 * judgment's record, not its text. A judgment the API had no document for
 * stores `document-status` instead, and an unreadable listing row stores
 * only its `quarantine` record.
 */
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isCDATA, isTag, isText } from "domhandler";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

const DOCUMENT_PART = "document";

/** Elements whose text is one paragraph of the judgment as the court wrote it. */
const PARAGRAPH_ELEMENTS = new Set(["xText", "xTitle", "xName"]);

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** A node's characters as the XML holds them, marks and all. */
const xmlTextOf = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  return isTag(node) || isCDATA(node)
    ? node.children.map(xmlTextOf).join("")
    : "";
};

/**
 * The same characters with a word boundary where the court's editor broke
 * the line (`xBRx`) or raised a superscript (`xSUPx`, "art. 353 1"). The XML
 * runs the words on either side together; the word comparison reads them
 * apart, as the court's rendering prints them, and the oracle reports the
 * difference as a boundary rather than as missing words.
 */
const spacedTextOf = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  if (!isTag(node) && !isCDATA(node)) {
    return "";
  }
  const children = node.children.map(spacedTextOf).join("");
  return isTag(node) && (node.name === "xBRx" || node.name === "xSUPx")
    ? ` ${children}`
    : children;
};

type Paragraph = { text: string; spaced: string };

const paragraphsOf = (root: Element): Paragraph[] => {
  const paragraphs: Paragraph[] = [];
  const push = (node: AnyNode): void => {
    const text = collapse(xmlTextOf(node));
    if (text.length > 0) {
      paragraphs.push({ text, spaced: collapse(spacedTextOf(node)) });
    }
  };
  const walk = (node: AnyNode): void => {
    if (isText(node) || isCDATA(node)) {
      // Text the editor left straight in a container is the judgment's too.
      push(node);
      return;
    }
    if (!isTag(node)) {
      return;
    }
    if (PARAGRAPH_ELEMENTS.has(node.name)) {
      // The root's own name labels the document ("Wyrok+Uzasadnienie");
      // every other name is a unit's heading or number, printed as text.
      if (!(node.name === "xName" && node.parent === root)) {
        push(node);
      }
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const child of root.children) {
    walk(child);
  }
  return paragraphs;
};

export const projectPlNcourtSourceRaw = (
  sourceRaw: string,
): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const xml = parts[DOCUMENT_PART];
  if (xml === undefined) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first().get(0);
  if (root === undefined || !isTag(root) || root.name !== "xPart") {
    // The API's `<error>` answer or an HTML page stored as the document.
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  // A paragraph the court repeats is one paragraph to the oracle; the word
  // comparison has to cover the same text, or the oracle ignores it.
  const seen = new Set<string>();
  const paragraphs: string[] = [];
  const spaced: string[] = [];
  for (const paragraph of paragraphsOf(root)) {
    if (!seen.has(paragraph.text)) {
      seen.add(paragraph.text);
      paragraphs.push(paragraph.text);
      spaced.push(paragraph.spaced);
    }
  }
  return {
    type: "source",
    source: { type: "paragraphs", paragraphs },
    options: { wordComparisonText: spaced.join(" ") },
  };
};

export const plNcourtRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) =>
    await Promise.resolve(projectPlNcourtSourceRaw(sourceRaw)),
};
