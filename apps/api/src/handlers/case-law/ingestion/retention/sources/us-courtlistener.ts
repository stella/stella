/**
 * The publisher's text of a CourtListener cluster, read from its stored raw.
 *
 * The envelope keeps each snapshot table of the record as a JSON part. The
 * decision text is the cluster's front matter (`headmatter`, `headnotes`,
 * `syllabus`, `summary`) and, for each opinion row, the first text column
 * that holds anything, in the order CourtListener documents as most to least
 * structured. `xml_scan` is positioned glyphs, never text. The rest of the
 * record (docket, court, citations, judges) is metadata.
 *
 * Every column is read as what it holds: Harvard XML, HTML, or plain text.
 * Pagination the publisher sets inline (Harvard `page-number`, the
 * `star-pagination` spans, `page-label` anchors, a footnote's back link) is
 * left out: it marks where a printed page broke, and the document keeps it as
 * an anchor rather than as words.
 */
import { Result } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

// Type-only: the part names stay the adapter's, without running its code.
import type { COURTLISTENER_RAW_PART } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/raw";
// Type-only: the column precedence is checked against the parser's list.
import type { COURTLISTENER_TEXT_FORMATS } from "@/api/handlers/case-law/ingestion/parsers/courtlistener/select";
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const CLUSTER_PART: (typeof COURTLISTENER_RAW_PART)["CLUSTER"] = "cl-cluster";
const OPINIONS_PART: (typeof COURTLISTENER_RAW_PART)["OPINIONS"] =
  "cl-opinions";

/** Text columns of an opinion row, most structured first. */
const TEXT_COLUMNS = [
  "xml_harvard",
  "html_with_citations",
  "html_lawbox",
  "html_columbia",
  "html_anon_2020",
  "html",
  "plain_text",
] as const satisfies typeof COURTLISTENER_TEXT_FORMATS;

/** Front-matter columns of the cluster row, in reading order. */
const FRONT_MATTER_COLUMNS = [
  "headmatter",
  "headnotes",
  "syllabus",
  "summary",
] as const;

/** Run-level markup: its text continues the line it sits in. */
const INLINE_ELEMENTS = new Set([
  "a",
  "abbr",
  "b",
  "big",
  "bracketnum",
  "cite",
  "code",
  "del",
  "em",
  "extracted-citation",
  "font",
  "footnotemark",
  "i",
  "ins",
  "mark",
  "q",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "tt",
  "u",
]);

/** Elements no reader sees as text. */
const HIDDEN_ELEMENTS = new Set([
  "head",
  "script",
  "style",
  "template",
  "title",
]);

/** Top-level elements that make a `plain_text` column an HTML document. */
const STRUCTURAL_ROOTS = new Set([
  "article",
  "body",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "html",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

const XML_DECLARATION = /^\s*<\?xml[^?]*\?>/u;
const HARVARD_ROOT = /^<opinion[\s>/]/u;
const MARKUP = /<[a-z][^>]*>/iu;
const BLANK_LINE = /\n[ \t\f]*\n/u;

const classesOf = (element: Element): readonly string[] =>
  (element.attribs["class"] ?? "").split(/\s+/u);

/** Inline pagination the document keeps as a page anchor, not as words. */
const isPagination = (element: Element): boolean => {
  const classes = classesOf(element);
  const parent = element.parent;
  return (
    element.name === "page-number" ||
    (element.name === "span" && classes.includes("star-pagination")) ||
    (element.name === "a" && classes.includes("page-label")) ||
    (element.name === "a" &&
      classes.includes("footnote") &&
      parent !== null &&
      isTag(parent) &&
      parent.name === "div" &&
      classesOf(parent).includes("footnote"))
  );
};

const collapsed = (text: string): string => text.replace(/\s+/gu, " ").trim();

const plainParagraphs = (text: string): string[] =>
  text
    .replace(/\r\n?/gu, "\n")
    .split(BLANK_LINE)
    .map(collapsed)
    .filter((paragraph) => paragraph !== "");

/** The text of an inline run, pagination and hidden markup left out. */
const runText = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  if (!isTag(node) || HIDDEN_ELEMENTS.has(node.name) || isPagination(node)) {
    return "";
  }
  if (node.name === "br") {
    return "\n";
  }
  return node.children.map(runText).join("");
};

/**
 * Whether a node continues the line it sits in. Pagination does: a page that
 * broke mid-word ("investí-<page-number>*963</page-number>gate") is one word.
 */
const isInline = (node: AnyNode): boolean =>
  !isTag(node) ||
  isPagination(node) ||
  ((INLINE_ELEMENTS.has(node.name) || node.name === "br") &&
    node.children.every(isInline));

/**
 * The paragraphs of a markup tree: an inline run is one paragraph, and any
 * element that is not run-level markup (a paragraph, a block quote, a table
 * cell, a Harvard `author`) starts and ends one. A `pre` block keeps the
 * paragraphs its blank lines separate.
 */
const collectParagraphs = (nodes: readonly AnyNode[], paragraphs: string[]) => {
  let run = "";
  const flush = () => {
    const text = collapsed(run);
    if (text !== "") {
      paragraphs.push(text);
    }
    run = "";
  };
  for (const node of nodes) {
    if (isInline(node)) {
      run += runText(node);
      continue;
    }
    flush();
    if (!isTag(node) || HIDDEN_ELEMENTS.has(node.name)) {
      continue;
    }
    if (node.name === "pre") {
      paragraphs.push(...plainParagraphs(runText(node)));
      continue;
    }
    collectParagraphs(node.children, paragraphs);
  }
  flush();
};

const markupParagraphs = (markup: string, xml: boolean): string[] => {
  const $ = xml
    ? cheerio.load(markup.replace(XML_DECLARATION, ""), { xml: true })
    : cheerio.load(markup);
  const nodes = xml
    ? $.root().contents().toArray()
    : $("body").first().contents().toArray();
  const paragraphs: string[] = [];
  collectParagraphs(nodes, paragraphs);
  return paragraphs;
};

/** Whether a `plain_text` column holds an HTML document after all. */
const holdsHtmlDocument = (text: string): boolean => {
  const roots = cheerio.load(text, {}, false).root().contents().toArray();
  let structural = false;
  for (const node of roots) {
    if (isText(node) && node.data.trim() !== "") {
      return false;
    }
    if (isTag(node)) {
      if (!STRUCTURAL_ROOTS.has(node.name.toLowerCase())) {
        return false;
      }
      structural = true;
    }
  }
  return structural;
};

const columnParagraphs = (
  column: (typeof TEXT_COLUMNS)[number],
  text: string,
): string[] => {
  if (
    column === "xml_harvard" ||
    HARVARD_ROOT.test(text.replace(XML_DECLARATION, "").trimStart())
  ) {
    return markupParagraphs(text, true);
  }
  if (column === "plain_text" && !holdsHtmlDocument(text)) {
    return plainParagraphs(text);
  }
  return markupParagraphs(text, false);
};

const stringField = (row: Record<string, unknown>, name: string): string => {
  const value = row[name];
  return typeof value === "string" ? value : "";
};

// What CourtListener writes into a text column in place of an opinion it
// could not extract or never had. Kept here, independently of the parser's
// classifier: a column holding only one of these is not the opinion's text,
// and comparing a parse of a lower column against it would read as complete.
// The opinion number the publisher interpolates is any short token.
const PLACEHOLDER_MESSAGES = [
  /^unable to extract document content$/u,
  /^failed to extract text$/u,
  /^(?:file )?unavailable$/u,
  /^no opinion found\.? ?click here to view source material$/u,
  /^decision removed at the request of the court$/u,
  /^entry removed as entered in error$/u,
  /^test(?:ing)? (?:document|pdf)$/u,
  /^memorandum decisions$/u,
  /^opinion (?:x )?(?:\S+ ){1,3}was never (?:issued|released)(?: o[rh] was withdrawn)?$/u,
  /^this opinion (?:has been withdrawn|was never issued|was withdrawn)\.? (?:opinion|no\.|case) \S+(?: ')?$/u,
  /^usca\d{1,2} opinion can't open \S+$/u,
] as const;

/** Letters, against what only a byte stream decoded wrongly produces. */
const READABLE_LETTER = /\p{L}/gu;
const UNDECODED = /[\ufffd\p{Cc}]|\u00ff\u00fe|\u00fe\u00ff/gu;

/**
 * Whether a column's text is an opinion a reader could read: not empty, not
 * a publisher placeholder, and not mostly bytes decoded with the wrong
 * character set.
 */
const holdsOpinionText = (paragraphs: readonly string[]): boolean => {
  const text = paragraphs.join(" ").replace(/\s+/gu, " ").trim();
  // Trailing stops trimmed by a scan, not a `[.\s]+$` pattern, whose
  // backtracking is quadratic on a long run of them.
  let end = text.length;
  while (end > 0 && (text[end - 1] === "." || text[end - 1] === " ")) {
    end -= 1;
  }
  const message = text.slice(0, end).toLowerCase();
  if (PLACEHOLDER_MESSAGES.some((pattern) => pattern.test(message))) {
    return false;
  }
  const letters = text.match(READABLE_LETTER)?.length ?? 0;
  const undecoded = text.match(UNDECODED)?.length ?? 0;
  return letters > 0 && undecoded * 10 < letters;
};

/**
 * The first column that holds the opinion's text, in the publisher's
 * documented precedence. A blank, placeholder or undecodable column is
 * passed over, as a reader would pass over it.
 */
const opinionParagraphs = (row: Record<string, unknown>): string[] => {
  for (const column of TEXT_COLUMNS) {
    const text = stringField(row, column);
    if (text.trim() === "") {
      continue;
    }
    const paragraphs = columnParagraphs(column, text);
    if (holdsOpinionText(paragraphs)) {
      return paragraphs;
    }
  }
  return [];
};

const frontMatterParagraphs = (cluster: Record<string, unknown>): string[] =>
  FRONT_MATTER_COLUMNS.flatMap((column) => {
    const text = stringField(cluster, column);
    if (text.trim() === "") {
      return [];
    }
    // The snapshot mixes plain and HTML apparatus within each column.
    return column === "headmatter" || MARKUP.test(text)
      ? markupParagraphs(text, false)
      : plainParagraphs(text);
  });

/** A part's JSON, or `undefined` for a part that is absent or malformed. */
const parsedPart = (text: string | undefined): unknown =>
  text === undefined
    ? undefined
    : Result.try({
        try: (): unknown => JSON.parse(text),
        catch: () => undefined,
      }).unwrapOr(undefined);

const projectCourtListenerCluster = (
  sourceRaw: string,
): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const cluster = parsedPart(parts[CLUSTER_PART]);
  const opinions = parsedPart(parts[OPINIONS_PART]);
  if (!isRecord(cluster) || !isUnknownArray(opinions)) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  const paragraphs = [
    ...frontMatterParagraphs(cluster),
    ...opinions.filter(isRecord).flatMap(opinionParagraphs),
  ];
  if (paragraphs.length === 0) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  // HTML rather than paragraph data, so the oracle reads each paragraph
  // through the publisher policy (letter-spaced runs folded) as it reads
  // the blocks. The registry supplies that policy (`retention-sources.ts`),
  // so this module stays independent of the parser that shares it.
  return {
    type: "source",
    source: `<body>${paragraphs.map((paragraph) => `<p>${Bun.escapeHTML(paragraph)}</p>`).join("")}</body>`,
  };
};

export const usCourtlistenerRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) =>
    await Promise.resolve(projectCourtListenerCluster(sourceRaw)),
};
