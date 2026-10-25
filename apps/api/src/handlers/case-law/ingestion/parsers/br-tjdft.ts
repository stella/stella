/**
 * Reader for the full text the TJDFT jurisprudence search serves as
 * `inteiroTeorHtml`.
 *
 * The court has published two shapes over the years, and the field holds
 * whichever one the decision was stored in:
 *
 * - Electronic-process documents (PJe, roughly 2016 on) are word-processor
 *   HTML: paragraphs, tables for the letterhead and the case data, section
 *   titles printed as a paragraph of bold capitals ("EMENTA", "ACÓRDÃO",
 *   "RELATÓRIO", "VOTOS"). The markup nests block elements inside inline
 *   ones; the HTML parser's own recovery flattens that, so the walk reads
 *   blocks wherever they sit.
 * - Older documents are one `<pre>` element: a text rendering with hard line
 *   wraps, blank lines between paragraphs, pipe-bordered boxes for the case
 *   data and the operative part, and titles centred on a line of their own
 *   ("E M E N T A").
 *
 * Structure is read from that markup and that layout only: a heading is a
 * paragraph the court printed wholly in bold capitals, or a centred line of
 * capitals, never a word the parser recognises. Text the reader cannot
 * classify stays a plain paragraph in document order (rule 10).
 */

import { panic } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import type {
  Block,
  DocumentAst,
  Inline,
  TableBlock,
  TableCell,
} from "@stll/legal-ast/document-ast";

import { isExcludedHtmlTag } from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

const SOURCE_SYSTEM = "jurisdf.tjdft.jus.br";

/** Elements that end the paragraph before them and start a new one. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "center",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "ul",
]);

/** A title is a short line; a bold capitals paragraph longer than this is prose. */
const MAX_HEADING_LENGTH = 80;

/** Leading spaces that centre a line in the 76-column text rendering. */
const CENTRED_INDENT = 20;

type Marks = { bold: boolean; italic: boolean; href: string | undefined };

const NO_MARKS: Marks = { bold: false, italic: false, href: undefined };

type Run =
  { type: "text"; text: string; marks: Marks } | { type: "line-break" };

type PendingParagraph = { runs: Run[]; quote: boolean };

type ParseState = {
  $: cheerio.CheerioAPI;
  blocks: Block[];
  pending: PendingParagraph;
};

const collapseSpaces = (text: string): string => text.replace(/[\s ]+/gu, " ");

const sameMarks = (left: Marks, right: Marks): boolean =>
  left.bold === right.bold &&
  left.italic === right.italic &&
  left.href === right.href;

/** Trim a run list at both ends and around its line breaks, dropping empties. */
const trimRuns = (runs: readonly Run[]): Run[] => {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.type === "line-break") {
      const last = out.at(-1);
      if (last?.type === "text") {
        last.text = last.text.trimEnd();
      }
      out.push(run);
      continue;
    }
    const last = out.at(-1);
    const text =
      last === undefined || last.type === "line-break"
        ? run.text.trimStart()
        : run.text;
    if (text.length === 0) {
      continue;
    }
    if (last?.type === "text" && sameMarks(last.marks, run.marks)) {
      last.text = collapseSpaces(`${last.text}${text}`);
      continue;
    }
    if (last?.type === "text" && last.text.endsWith(" ")) {
      out.push({ ...run, text: text.trimStart() });
      continue;
    }
    out.push({ ...run, text });
  }
  while (out.at(-1)?.type === "line-break") {
    out.pop();
  }
  while (out.at(0)?.type === "line-break") {
    out.shift();
  }
  const last = out.at(-1);
  if (last?.type === "text") {
    last.text = last.text.trimEnd();
  }
  return out.filter((run) => run.type !== "text" || run.text.length > 0);
};

const inlineOfRun = (run: Run): Inline => {
  if (run.type === "line-break") {
    return { type: "line-break" };
  }
  let inline: Inline = { type: "text", text: run.text };
  if (run.marks.italic) {
    inline = { type: "italic", children: [inline] };
  }
  if (run.marks.bold) {
    inline = { type: "bold", children: [inline] };
  }
  if (run.marks.href !== undefined) {
    inline = { type: "link", href: run.marks.href, children: [inline] };
  }
  return inline;
};

const plainTextOfRuns = (runs: readonly Run[]): string =>
  runs.map((run) => (run.type === "line-break" ? "\n" : run.text)).join("");

/**
 * Capitals, with no lower-case letter, short enough to be a title and not
 * closed like a sentence: the operative decision is printed in capitals too
 * ("CONCEDEU-SE A ORDEM. MAIORIA."), and it ends with its full stop.
 */
const isCapitalsTitle = (text: string): boolean =>
  text.length <= MAX_HEADING_LENGTH &&
  /\p{Lu}/u.test(text) &&
  !/\p{Ll}/u.test(text) &&
  !/[.;:"”»]$/u.test(text);

/**
 * A paragraph the court set wholly in bold capitals and short enough to be a
 * title. Capitals alone are not enough: the court writes whole headnotes in
 * capitals, and those run far past a title's length.
 */
const isPrintedTitle = (runs: readonly Run[]): boolean => {
  const texts = runs.filter(
    (run): run is Extract<Run, { type: "text" }> =>
      run.type === "text" && run.text.trim().length > 0,
  );
  if (texts.length === 0 || runs.some((run) => run.type === "line-break")) {
    return false;
  }
  return (
    texts.every(({ marks }) => marks.bold) &&
    isCapitalsTitle(plainTextOfRuns(texts).trim())
  );
};

const nextIds = (state: ParseState) => {
  const index = state.blocks.length + 1;
  return { id: `b${index}`, anchorId: `p-${index}` };
};

const pushRunsBlock = (
  state: ParseState,
  runs: readonly Run[],
  options: { quote: boolean; heading: boolean },
): void => {
  const trimmed = trimRuns(runs);
  const plainText = plainTextOfRuns(trimmed);
  if (plainText.trim().length === 0) {
    return;
  }
  const inlines = trimmed.map(inlineOfRun);
  if (options.heading || isPrintedTitle(trimmed)) {
    state.blocks.push({
      ...nextIds(state),
      type: "heading",
      level: 1,
      role: "section-heading",
      inlines,
      plainText,
    });
    return;
  }
  state.blocks.push({
    ...nextIds(state),
    type: "paragraph",
    ...(options.quote ? { role: "quote" as const } : {}),
    inlines,
    plainText,
  });
};

const flush = (state: ParseState): void => {
  const { runs, quote } = state.pending;
  state.pending = { runs: [], quote };
  pushRunsBlock(state, runs, { quote, heading: false });
};

const marksOf = (element: Element, marks: Marks): Marks => {
  const tag = element.tagName.toLowerCase();
  if (tag === "b" || tag === "strong") {
    return { ...marks, bold: true };
  }
  if (tag === "i" || tag === "em") {
    return { ...marks, italic: true };
  }
  if (tag === "a") {
    const href = sanitizeUrl(element.attribs["href"]);
    return href === undefined ? marks : { ...marks, href };
  }
  return marks;
};

type RunSink = (run: Run) => void;

/**
 * Text of a subtree as runs, block boundaries read as line breaks. Used where
 * the court put paragraphs inside a table cell: the cell is one run of text,
 * and its paragraphs stay apart.
 */
const collectRuns = (node: AnyNode, marks: Marks, sink: RunSink): void => {
  if (isText(node)) {
    sink({ type: "text", text: collapseSpaces(node.data), marks });
    return;
  }
  if (!isTag(node)) {
    return;
  }
  const tag = node.tagName.toLowerCase();
  if (isExcludedHtmlTag(tag)) {
    return;
  }
  if (tag === "br") {
    sink({ type: "line-break" });
    return;
  }
  if (tag === "img") {
    const alt = node.attribs["alt"]?.trim();
    if (alt) {
      sink({ type: "text", text: alt, marks });
    }
    return;
  }
  const boundary =
    BLOCK_TAGS.has(tag) || tag === "tr" || tag === "table" || tag === "pre";
  if (boundary) {
    sink({ type: "line-break" });
  }
  const childMarks = marksOf(node, marks);
  for (const child of node.children) {
    collectRuns(child, childMarks, sink);
  }
  if (tag === "td" || tag === "th") {
    sink({ type: "text", text: " ", marks });
  }
  if (boundary) {
    sink({ type: "line-break" });
  }
};

/** Line breaks the walk inserted at block edges collapse to one. */
const singleBreaks = (runs: readonly Run[]): Run[] => {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.type === "line-break" && out.at(-1)?.type === "line-break") {
      continue;
    }
    out.push(run);
  }
  return out;
};

const cellOf = (cell: Element): TableCell => {
  const runs: Run[] = [];
  for (const child of cell.children) {
    collectRuns(child, NO_MARKS, (run) => {
      runs.push(run);
    });
  }
  const trimmed = trimRuns(singleBreaks(runs));
  // A span of one, or one the markup does not state as a whole number, is
  // no span.
  const spanOf = (attribute: string) =>
    parseIntegerToken(cell.attribs[attribute], {
      sign: "unsigned",
      min: 2,
    }).unwrapOr(undefined);
  const colSpan = spanOf("colspan");
  const rowSpan = spanOf("rowspan");
  return {
    inlines: trimmed.map(inlineOfRun),
    plainText: plainTextOfRuns(trimmed),
    ...(colSpan === undefined ? {} : { colSpan }),
    ...(rowSpan === undefined ? {} : { rowSpan }),
    ...(cell.tagName.toLowerCase() === "th" ? { header: true as const } : {}),
  };
};

const ownRows = (table: Element): Element[] =>
  table.children.flatMap((child) => {
    if (!isTag(child)) {
      return [];
    }
    const tag = child.tagName.toLowerCase();
    if (tag === "tr") {
      return [child];
    }
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      return child.children.filter(
        (row): row is Element => isTag(row) && row.tagName === "tr",
      );
    }
    return [];
  });

const cellsOf = (row: Element): Element[] =>
  row.children.filter(
    (cell): cell is Element =>
      isTag(cell) && (cell.tagName === "td" || cell.tagName === "th"),
  );

/**
 * The table the court printed, with its empty spacer rows left out.
 *
 * A table no row of which holds text in more than one cell is layout, not
 * data: the letterhead beside the court's logo, and the votes, each set in a
 * row of its own. Its cells are read as the document flow they hold, so a
 * vote keeps its paragraphs and headings instead of becoming one cell.
 */
const readTable = (
  state: ParseState,
  table: Element,
  flowInto: (cell: Element) => void,
): void => {
  // A caption is the table's own text, printed above its rows; anything
  // else in the table that is neither a row nor a row group is read in place
  // too, so no text the court put in a table is left out (rule 10).
  for (const child of table.children) {
    if (!isTag(child)) {
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (
      tag !== "tr" &&
      tag !== "thead" &&
      tag !== "tbody" &&
      tag !== "tfoot" &&
      tag !== "colgroup" &&
      tag !== "col"
    ) {
      flowInto(child);
    }
  }
  const rows = ownRows(table).map((row) =>
    cellsOf(row).map((cell) => ({ element: cell, cell: cellOf(cell) })),
  );
  const filledRows = rows.filter((cells) =>
    cells.some(({ cell }) => cell.plainText.length > 0),
  );
  if (filledRows.length === 0) {
    return;
  }
  const isLayout = filledRows.every(
    (cells) =>
      cells.filter(({ cell }) => cell.plainText.length > 0).length <= 1,
  );
  if (isLayout) {
    for (const cells of filledRows) {
      for (const { element, cell } of cells) {
        if (cell.plainText.length > 0) {
          flowInto(element);
        }
      }
    }
    return;
  }
  const block: TableBlock = {
    ...nextIds(state),
    type: "table",
    ...(table.attribs["id"] === "tabelaDadosProcesso"
      ? { role: "metadata-table" as const }
      : {}),
    rows: filledRows.map((cells) => cells.map(({ cell }) => cell)),
    plainText: filledRows
      .map((cells) => cells.map(({ cell }) => cell.plainText).join(" "))
      .join("\n"),
  };
  state.blocks.push(block);
};

// ── Preformatted text ────────────────────────────────────

type PreLine =
  | { type: "blank" }
  | { type: "row"; cells: string[] }
  | { type: "box"; text: string }
  | { type: "text"; text: string; indent: number };

/**
 * One line of the text rendering by its own shape: a bordered line with
 * inner borders is a table row, a bordered line without them is a line of a
 * box, anything else is text.
 */
const classifyPreLine = (line: string): PreLine => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { type: "blank" };
  }
  const bordered = /^\|(?<inner>.*)\|$/u.exec(trimmed)?.groups?.["inner"];
  if (bordered !== undefined) {
    if (bordered.includes("|")) {
      return {
        type: "row",
        cells: bordered.split("|").map((cell) => collapseSpaces(cell).trim()),
      };
    }
    return { type: "box", text: collapseSpaces(bordered).trim() };
  }
  return {
    type: "text",
    text: collapseSpaces(trimmed),
    indent: line.length - line.trimStart().length,
  };
};

const pushPreTable = (state: ParseState, rows: readonly string[][]): void => {
  const kept = rows.filter((cells) => cells.some((cell) => cell.length > 0));
  if (kept.length === 0) {
    return;
  }
  // A bordered row whose only text is a title is the title's frame.
  const filled = kept.flat().filter((cell) => cell.length > 0);
  const title = filled.at(0);
  if (kept.length === 1 && filled.length === 1 && title !== undefined) {
    pushRunsBlock(state, [{ type: "text", text: title, marks: NO_MARKS }], {
      quote: false,
      heading: isCapitalsTitle(title),
    });
    return;
  }
  const cells = kept.map((row) =>
    row.map((text): TableCell => ({
      inlines: text.length === 0 ? [] : [{ type: "text", text }],
      plainText: text,
    })),
  );
  state.blocks.push({
    ...nextIds(state),
    type: "table",
    rows: cells,
    plainText: kept.map((row) => row.join(" ").trim()).join("\n"),
  });
};

const pushPreParagraph = (
  state: ParseState,
  lines: readonly string[],
  heading: boolean,
): void => {
  const text = lines.join(" ");
  pushRunsBlock(state, [{ type: "text", text, marks: NO_MARKS }], {
    quote: false,
    heading,
  });
};

/**
 * Paragraphs of the text rendering. Hard-wrapped lines join into the
 * paragraph they were broken from; a blank line, an empty box line or a
 * change of line shape ends one. A paragraph of one line of capitals,
 * centred, is a title.
 */
const readPreformattedText = (state: ParseState, text: string): void => {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n").map(classifyPreLine);
  let rows: string[][] = [];
  let paragraph: string[] = [];
  let paragraphShape: "box" | "text" | undefined;
  let firstIndent = 0;

  const endParagraph = () => {
    if (paragraph.length > 0) {
      // A title stands alone: centred on its line, or alone in its box.
      const single = paragraph.at(0) ?? "";
      const heading =
        paragraph.length === 1 &&
        (paragraphShape === "box" || firstIndent >= CENTRED_INDENT) &&
        isCapitalsTitle(single);
      pushPreParagraph(state, paragraph, heading);
    }
    paragraph = [];
    paragraphShape = undefined;
  };
  const endRows = () => {
    pushPreTable(state, rows);
    rows = [];
  };

  for (const line of lines) {
    switch (line.type) {
      case "blank":
        endParagraph();
        endRows();
        break;
      case "row":
        endParagraph();
        rows.push(line.cells);
        break;
      case "box":
        endRows();
        if (line.text.length === 0) {
          endParagraph();
          break;
        }
        if (paragraphShape !== "box") {
          endParagraph();
          paragraphShape = "box";
        }
        paragraph.push(line.text);
        break;
      case "text":
        endRows();
        if (paragraphShape !== "text") {
          endParagraph();
          paragraphShape = "text";
          firstIndent = line.indent;
        }
        paragraph.push(line.text);
        break;
      default:
        line satisfies never;
        panic(`Unhandled TJDFT text line: ${JSON.stringify(line)}`);
    }
  }
  endParagraph();
  endRows();
};

// ── Markup walk ──────────────────────────────────────────

const walk = (state: ParseState, node: AnyNode, marks: Marks): void => {
  if (isText(node)) {
    state.pending.runs.push({
      type: "text",
      text: collapseSpaces(node.data),
      marks,
    });
    return;
  }
  if (!isTag(node)) {
    return;
  }
  const tag = node.tagName.toLowerCase();
  if (isExcludedHtmlTag(tag) || tag === "head") {
    return;
  }
  if (tag === "br") {
    state.pending.runs.push({ type: "line-break" });
    return;
  }
  if (tag === "img") {
    // The letterhead logo is an inline data URI with no alternative text; an
    // image carries no words, and a `data:` source cannot enter the AST.
    const alt = node.attribs["alt"]?.trim();
    if (alt) {
      state.pending.runs.push({ type: "text", text: alt, marks });
    }
    return;
  }
  if (tag === "table") {
    flush(state);
    readTable(state, node, (cell) => {
      for (const child of cell.children) {
        walk(state, child, marks);
      }
      flush(state);
    });
    return;
  }
  if (tag === "pre") {
    flush(state);
    readPreformattedText(state, state.$(node).text());
    return;
  }
  if (BLOCK_TAGS.has(tag)) {
    flush(state);
    const outerQuote = state.pending.quote;
    if (tag === "blockquote") {
      state.pending.quote = true;
    }
    for (const child of node.children) {
      walk(state, child, marks);
    }
    flush(state);
    state.pending.quote = outerQuote;
    return;
  }
  const childMarks = marksOf(node, marks);
  for (const child of node.children) {
    walk(state, child, childMarks);
  }
};

/**
 * What the decision's document is read from: the full text the court
 * published as markup, as plain text, or, where it published no full text,
 * the record itself (the headnote and the operative decision the court
 * states for every judgment).
 */
export type BrTjdftDocumentContent =
  | { type: "html"; text: string }
  | { type: "text"; text: string }
  | { type: "record"; ementa: string | undefined; decisao: string | undefined };

export type ParseBrTjdftDocumentInput = {
  content: BrTjdftDocumentContent;
  documentId: string;
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string;
};

export type ParseBrTjdftDocumentOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

const readRecord = (
  state: ParseState,
  ementa: string | undefined,
  decisao: string | undefined,
): void => {
  if (ementa !== undefined) {
    pushRunsBlock(
      state,
      [{ type: "text", text: collapseSpaces(ementa), marks: NO_MARKS }],
      { quote: false, heading: false },
    );
  }
  if (decisao === undefined) {
    return;
  }
  const before = state.blocks.length;
  pushRunsBlock(
    state,
    [{ type: "text", text: collapseSpaces(decisao), marks: NO_MARKS }],
    { quote: false, heading: false },
  );
  const holding = state.blocks.at(before);
  if (holding?.type === "paragraph") {
    holding.role = "holding";
  }
};

export const parseBrTjdftDocument = ({
  content,
  documentId,
  caseNumber,
  court,
  decisionDate,
  decisionType,
  sourceUrl,
}: ParseBrTjdftDocumentInput): ParseBrTjdftDocumentOutput => {
  const $ = cheerio.load(content.type === "html" ? content.text : "");
  const state: ParseState = {
    $,
    blocks: [],
    pending: { runs: [], quote: false },
  };
  switch (content.type) {
    case "html":
      for (const child of $("body").contents().toArray()) {
        walk(state, child, NO_MARKS);
      }
      flush(state);
      break;
    case "text":
      readPreformattedText(state, content.text);
      break;
    case "record":
      readRecord(state, content.ementa, content.decisao);
      break;
    default:
      content satisfies never;
      return panic(`Unhandled TJDFT content: ${JSON.stringify(content)}`);
  }

  return {
    documentAst: {
      version: 1,
      source: {
        system: SOURCE_SYSTEM,
        documentId,
        webUrl: sourceUrl,
        printUrl: "",
      },
      metadata: {
        caseNumber,
        ecli: null,
        court,
        decisionDate: decisionDate ?? null,
        decisionType: decisionType ?? null,
        keywords: [],
        statutes: [],
      },
      blocks: state.blocks,
    },
    fulltext: state.blocks.map((block) => block.plainText).join("\n\n"),
  };
};
