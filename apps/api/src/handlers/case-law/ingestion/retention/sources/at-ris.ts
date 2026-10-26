/**
 * The publisher's text of an Austrian RIS decision, read from its stored raw.
 *
 * Every RIS application (Justiz, VfGH, VwGH, BVwG, LVwG, AsylGH, UBAS, UVS,
 * BVA, US, BKS) stores the same envelope: the listing item, the decision's
 * own XML document and, where one was fetched, the headnote answer. The
 * decision text is the XML's `nutzdaten` element. Its `kzinhalt` and
 * `fzinhalt` children are the printed page header and footer (the host name,
 * the page number, the court and date repeated on every page), which are not
 * part of the decision.
 */
import * as cheerio from "cheerio";
import { type AnyNode, isTag, isText } from "domhandler";

// Type-only: the part name stays the adapter's, without running its code.
import type { AT_RIS_PART } from "@/api/handlers/case-law/ingestion/adapters/at-ris-fields";
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

const DOCUMENT_XML_PART: (typeof AT_RIS_PART)["DOCUMENT_XML"] = "document-xml";

/** Page furniture the document prints around the decision. */
const PAGE_FURNITURE = new Set(["kzinhalt", "fzinhalt"]);

/**
 * Elements the RIS schema sets as one printed paragraph each: headings,
 * paragraphs and the empty spacer between them.
 */
const PARAGRAPH_ELEMENTS = new Set(["absatz", "ueberschrift", "abstand"]);

/**
 * Elements printed as a character rather than as their content: the schema
 * spells a tab stop, a line break, a protected dash and the two angle
 * brackets as elements of their own, so `B<gdash/>VG` reads as "B-VG".
 */
const PRINTED_AS: Readonly<Record<string, string>> = {
  tab: " ",
  br: " ",
  gdash: "-",
  gt: ">",
  lt: "<",
};

/** Run-level markup that sits inside a paragraph's line of text. */
const INLINE_ELEMENTS = new Set([
  "b",
  "i",
  "u",
  "sup",
  "sub",
  "span",
  "feld",
  "gs",
]);

const collapsed = (text: string): string =>
  text.replace(/[\s ]+/gu, " ").trim();

/** One element's text as the reader sees it printed. */
const printedText = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  if (!isTag(node)) {
    return "";
  }
  const printed = PRINTED_AS[node.name];
  if (printed !== undefined) {
    return printed;
  }
  return node.children.map(printedText).join("");
};

const holdsParagraph = (node: AnyNode): boolean =>
  isTag(node) &&
  (PARAGRAPH_ELEMENTS.has(node.name) || node.children.some(holdsParagraph));

/**
 * The printed paragraphs under `node`, page furniture left out.
 *
 * A container (a section, a table) is read child by child; text between two
 * paragraphs is a paragraph of its own; an element that holds no paragraph
 * and is not run-level markup (a table cell, say) is one paragraph.
 */
const collectParagraphs = (node: AnyNode, paragraphs: string[]): void => {
  if (!isTag(node)) {
    return;
  }
  let run = "";
  const flush = () => {
    const text = collapsed(run);
    if (text !== "") {
      paragraphs.push(text);
    }
    run = "";
  };
  for (const child of node.children) {
    if (isTag(child) && PAGE_FURNITURE.has(child.name)) {
      continue;
    }
    if (!isTag(child)) {
      run += printedText(child);
      continue;
    }
    if (PARAGRAPH_ELEMENTS.has(child.name)) {
      flush();
      run = printedText(child);
      flush();
      continue;
    }
    if (holdsParagraph(child)) {
      flush();
      collectParagraphs(child, paragraphs);
      continue;
    }
    if (
      INLINE_ELEMENTS.has(child.name) ||
      PRINTED_AS[child.name] !== undefined
    ) {
      run += printedText(child);
      continue;
    }
    flush();
    run = printedText(child);
    flush();
  }
  flush();
};

const projectRisDecision = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const xml = parts[DOCUMENT_XML_PART];
  if (xml === undefined) {
    // A listing-only row: the publisher listed the decision without a
    // document the crawl could fetch.
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const $ = cheerio.load(xml, { xml: true });
  const content = $("nutzdaten").first().get(0);
  if (content === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  const paragraphs: string[] = [];
  collectParagraphs(content, paragraphs);
  if (paragraphs.length === 0) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  return { type: "source", source: { type: "paragraphs", paragraphs } };
};

/** One projection for every RIS application: they store one raw shape. */
export const atRisRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) =>
    await Promise.resolve(projectRisDecision(sourceRaw)),
};
