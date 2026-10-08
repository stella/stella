/**
 * Czech Supreme Court (Nejvyšší soud) HTML parser.
 *
 * Converts WebPrint HTML from rozhodnuti.nsoud.cz into a
 * canonical DocumentAst. Two-pass approach:
 *
 *   1. DOM -> ordered raw chunks (inline trees + tables)
 *   2. Raw chunks -> semantic blocks (headings, paragraphs,
 *      ruling items, tables)
 */

import * as cheerio from "cheerio";
import { type AnyNode, Element, isTag, isText, Text } from "domhandler";

import {
  CZ_CLOSING_RE as CLOSING_RE,
  CZ_JUDGE_NAME_RE as SIGNATURE_RE,
  CZ_JUDGE_TITLE_RE as PREDSEDA_RE,
} from "@stll/legal-ast/czech-document-roles";
// parser-output-unchanged: imports the document AST from its package owner
import type {
  Block,
  DocumentAst,
  DocumentAstMetadata,
  Inline,
  ParagraphBlock,
  TableCell,
} from "@stll/legal-ast/document-ast";

import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

import {
  inlinesToPlainText,
  isExcludedHtmlTag,
  ownTableRows,
  visibleHtmlText,
  walkInlines as walkInlinesShared,
} from "./shared-inlines";

/**
 * Source text the AST is expected to account for.
 *
 * The metadata table above the decision body is extracted into
 * `metadata` rather than into blocks, so validating against the whole
 * page would report it as lost text. Everything else on the page must
 * reach the AST.
 */
const validationHtml = ($: cheerio.CheerioAPI): string => {
  const $body = $("body").clone();
  $body.find("#box-table-a").remove();
  return `<html><body>${$body.html() ?? ""}</body></html>`;
};

// ── Public API ─────────────────────────────────────────────

export type ParseNsDecisionInput = {
  documentId: string;
  webUrl: string;
  printUrl: string;
  webHtml: string;
  printHtml: string;
};

type ParseNsDecisionOutput = {
  metadata: DocumentAstMetadata;
  sourceMetadata: NsSourceMetadata;
  documentAst: DocumentAst;
  fulltext: string;
};

export const parseNsDecisionHtml = (
  input: ParseNsDecisionInput,
): ParseNsDecisionOutput => {
  const $ = cheerio.load(input.printHtml);

  const { canonical, source, relatedProceedingsTable } = extractNsMetadata($);
  const rawChunks = extractRawChunks($);
  const blocks = classifyBlocks(rawChunks, relatedProceedingsTable);
  const fulltext = blocksToPlainText(blocks);

  validateAndLog(
    {
      parser: "cz-ns",
      caseNumber: canonical.caseNumber ?? input.documentId,
      url: input.webUrl,
    },
    validationHtml($),
    blocks,
  );

  const documentAst: DocumentAst = {
    version: 1,
    source: {
      system: "cz_ns",
      documentId: input.documentId,
      webUrl: input.webUrl,
      printUrl: input.printUrl,
    },
    metadata: canonical,
    blocks,
  };

  return {
    metadata: canonical,
    sourceMetadata: source,
    documentAst,
    fulltext,
  };
};

// ── Metadata extraction ────────────────────────────────────

const DOMINO_DATE_RE = /^(?<month>\d{1,2})\/(?<day>\d{1,2})\/(?<year>\d{4})$/u;

const parseDominoDate = (raw: string): string | null => {
  const match = DOMINO_DATE_RE.exec(raw);
  if (!match) {
    return null;
  }
  const { month, day, year } = match.groups ?? {};
  if (month === undefined || day === undefined || year === undefined) {
    return null;
  }
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso
    ? null
    : iso;
};

type NsComplaintCell =
  | {
      type: "date";
      value: string;
      sourceValue: string;
      defects: readonly NsComplaintDefect[];
    }
  | {
      type: "text";
      value: string;
      sourceValue: string;
      defects: readonly NsComplaintDefect[];
    }
  | {
      type: "unresolved-date";
      sourceValue: string;
      defects: readonly NsComplaintDefect[];
    };

type NsComplaintDefect =
  | "duplicated-value"
  | "embedded-newlines"
  | "us-date-format"
  | "conflicting-values"
  | "invalid-date";

type NsSourceMetadata = Record<string, unknown> & {
  ustavniStiznost?: Record<string, NsComplaintCell>[];
};

// Domino publishes dates as month/day/year. Keep the cell's exact text even
// when its display repeats the same value; unrelated dates never replace it.
const complaintCell = (
  header: string,
  sourceValue: string,
): NsComplaintCell => {
  const parts = sourceValue
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const distinct = [...new Set(parts)];
  const defects: NsComplaintDefect[] = [];
  if (parts.length > distinct.length) {
    defects.push("duplicated-value");
  }
  if (/[\r\n]/u.test(sourceValue)) {
    defects.push("embedded-newlines");
  }
  const value = distinct.join("\n");
  if (!header.startsWith("datum")) {
    return { type: "text", value, sourceValue, defects };
  }
  if (distinct.some((part) => DOMINO_DATE_RE.test(part))) {
    defects.push("us-date-format");
  }
  if (distinct.length > 1) {
    return {
      type: "unresolved-date",
      sourceValue,
      defects: [...defects, "conflicting-values"],
    };
  }
  const iso = parseDominoDate(value);
  if (iso === null) {
    return {
      type: "unresolved-date",
      sourceValue,
      defects: [...defects, "invalid-date"],
    };
  }
  return { type: "date", value: iso, sourceValue, defects };
};

type SourceMetadataTable = {
  captions: string[];
  rows: { type: "header" | "data"; text: string }[][];
};

type MetadataResult = {
  canonical: DocumentAstMetadata;
  source: NsSourceMetadata;
  relatedProceedingsTable: TableCell[][] | null;
};

export const extractNsMetadata = ($: cheerio.CheerioAPI): MetadataResult => {
  const metaTable = $("#box-table-a");
  // Domino also escapes value separators, including inside complaint cells.
  // Restore only breaks; parsing the whole decoded value would eat quoted text.
  metaTable
    .find("*")
    .contents()
    .each((_, node) => {
      if (!isText(node)) {
        return;
      }
      const parts = node.data.split(/<br\s*\/?>/iu);
      if (parts.length === 1) {
        return;
      }
      const nodes: AnyNode[] = [];
      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          nodes.push(new Element("br", {}));
        }
        nodes.push(new Text(part));
      }
      $(node).replaceWith(nodes);
    });

  const canonical: DocumentAstMetadata = {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  };
  const source: NsSourceMetadata = {};
  let relatedProceedingsTable: TableCell[][] | null = null;

  const splitBrValues = (td: cheerio.Cheerio<AnyNode>) =>
    ($(td).html() ?? "").split(/<br\s*\/?>/iu).flatMap((s) => {
      const trimmed = visibleHtmlText(cheerio.load(s).root()).trim();
      return trimmed ? [trimmed] : [];
    });

  const metadataCellText = (cell: cheerio.Cheerio<AnyNode>) => {
    const copy = cell.clone();
    // Cheerio's text() omits breaks; keep boundaries without changing the DOM
    // used by the structured value splitter and complaint table walker.
    copy.find("br").each((_, br) => {
      $(br).replaceWith(new Text("\n"));
    });
    return visibleHtmlText(copy).trim();
  };

  const metadataTable: SourceMetadataTable = {
    captions: metaTable
      .children("caption")
      .toArray()
      .map((caption) => visibleHtmlText($(caption)).trim()),
    rows: [],
  };
  source["metadataTable"] = metadataTable;
  ownTableRows(metaTable).each((_, tr) => {
    const tds = $(tr).children("td, th");
    metadataTable.rows.push(
      tds.toArray().map((cell) => ({
        type: $(cell).is("th") ? "header" : "data",
        text: metadataCellText($(cell)),
      })),
    );
    if (tds.length < 2) {
      const singleTd = tds;
      if (
        singleTd.length === 1 &&
        visibleHtmlText(singleTd).includes("ústavní stížnost")
      ) {
        const nestedTable = singleTd.find("table");
        if (nestedTable.length > 0) {
          const rows: TableCell[][] = [];
          ownTableRows(nestedTable.first()).each((__, innerTr) => {
            const row: TableCell[] = [];
            $(innerTr)
              .children("td, th")
              .each((___, td) => {
                const inlines = walkInlines($, $(td));
                row.push({
                  inlines,
                  plainText: inlinesToPlainText(inlines),
                });
              });
            if (row.length > 0) {
              rows.push(row);
            }
          });
          relatedProceedingsTable = rows.length > 0 ? rows : null;

          if (rows.length > 1) {
            const headerRow = rows.at(0);
            if (!headerRow) {
              return;
            }
            const headers = headerRow.map((c) =>
              c.plainText.trim().toLowerCase(),
            );
            source.ustavniStiznost = rows.slice(1).map((row) => {
              const entry: Record<string, NsComplaintCell> = {};
              for (let i = 0; i < headers.length; i++) {
                const h = headers[i] ?? `col${i}`;
                entry[h] = complaintCell(h, row.at(i)?.plainText ?? "");
              }
              return entry;
            });
          }
        }
      }
      return;
    }

    const labelText = metadataCellText(tds.eq(0));
    const valueText = metadataCellText(tds.eq(1));

    if (!valueText) {
      return;
    }

    if (labelText.includes("Soud")) {
      canonical.court = valueText;
      return;
    }
    if (labelText.includes("Datum rozhodnutí")) {
      canonical.decisionDate = parseDominoDate(valueText) ?? valueText;
      return;
    }
    if (
      labelText.includes("Spisová značka") ||
      labelText.includes("Senátní značka")
    ) {
      canonical.caseNumber = valueText;
      return;
    }
    if (labelText.includes("ECLI")) {
      canonical.ecli = valueText;
      return;
    }
    if (labelText.includes("Typ rozhodnutí")) {
      canonical.decisionType = valueText;
      return;
    }
    if (labelText.includes("Kategorie rozhodnutí")) {
      source["kategorieRozhodnuti"] = valueText.trim();
      return;
    }
    if (labelText.includes("Zveřejněno na webu")) {
      source["zverejnenoNaWebu"] = parseDominoDate(valueText) ?? valueText;
      return;
    }

    if (labelText.includes("Heslo")) {
      const values = splitBrValues($(tds[1]));
      canonical.keywords = values;
      return;
    }
    if (labelText.includes("Dotčené předpisy")) {
      const values = splitBrValues($(tds[1]));
      canonical.statutes = values;
    }
  });

  return { canonical, source, relatedProceedingsTable };
};

// ── Pass 1: DOM -> raw chunks ──────────────────────────────

type RawChunk =
  | { kind: "inlines"; inlines: Inline[]; centered: boolean }
  | { kind: "table"; rows: TableCell[][] };

const walkInlines = (
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
): Inline[] => walkInlinesShared($, el, { sanitizeHref: sanitizeUrl });

const isCentered = (el: cheerio.Cheerio<AnyNode>): boolean => {
  if (el.attr("align") === "center") {
    return true;
  }
  const parent = el.parent();
  if (
    parent.length > 0 &&
    parent.prop("tagName")?.toLowerCase() === "div" &&
    parent.attr("align") === "center"
  ) {
    return true;
  }
  return false;
};

export const extractRawChunks = ($: cheerio.CheerioAPI): RawChunk[] => {
  const chunks: RawChunk[] = [];

  const trimLineBreaks = (inlines: Inline[]): Inline[] => {
    while (inlines.length > 0 && inlines[0]?.type === "line-break") {
      inlines.shift();
    }
    while (inlines.length > 0 && inlines.at(-1)?.type === "line-break") {
      inlines.pop();
    }
    return inlines;
  };

  /**
   * Split inlines on runs of 2+ line-breaks (paragraph
   * boundaries in older <br>-based HTML) and push each
   * segment as a separate chunk.
   */
  const flushInlines = (inlines: readonly Inline[], centered: boolean) => {
    const segments: Inline[][] = [[]];
    let consecutiveBr = 0;

    for (const node of inlines) {
      if (node.type === "line-break") {
        consecutiveBr++;
        if (consecutiveBr >= 2) {
          segments.push([]);
          consecutiveBr = 0;
          continue;
        }
        segments.at(-1)?.push(node);
        continue;
      }
      // Whitespace-only text nodes between <br> tags don't
      // reset the line-break counter. But outside a br
      // sequence they must be kept (e.g., space between
      // two <b> tags: "nemá" + " " + "právo").
      if (node.type === "text" && !node.text.trim()) {
        if (consecutiveBr > 0) {
          continue;
        }
        segments.at(-1)?.push(node);
        continue;
      }
      consecutiveBr = 0;
      segments.at(-1)?.push(node);
    }

    for (const seg of segments) {
      const trimmed = trimLineBreaks([...seg]);
      if (trimmed.length > 0) {
        chunks.push({
          kind: "inlines",
          inlines: trimmed,
          centered,
        });
      }
    }
  };

  // Buffer for accumulating top-level inline content.
  // Flushed on block-level boundaries (<p>, <div>, <table>).
  let inlineBuffer: Inline[] = [];
  let bufferCentered = false;

  const flushBuffer = () => {
    if (inlineBuffer.length === 0) {
      return;
    }
    flushInlines(inlineBuffer, bufferCentered);
    inlineBuffer = [];
    bufferCentered = false;
  };

  const appendToBuffer = (inlines: readonly Inline[], centered: boolean) => {
    if (centered) {
      bufferCentered = true;
    }
    inlineBuffer.push(...inlines);
  };

  const processNode = (node: AnyNode, parentCentered: boolean) => {
    if (isText(node)) {
      const text = node.data;
      if (text.trim()) {
        appendToBuffer([{ type: "text", text }], parentCentered);
      }
      return;
    }

    if (!isTag(node)) {
      return;
    }

    const tag = node.tagName.toLowerCase();
    const $node = $(node);

    if (isExcludedHtmlTag(tag) || tag === "input") {
      return;
    }

    // Block-level elements: flush buffer, then process
    if (tag === "table") {
      flushBuffer();
      $node.children("caption").each((_, caption) => {
        flushInlines(walkInlines($, $(caption)), false);
      });
      const rows: TableCell[][] = [];
      ownTableRows($node).each((_, tr) => {
        const row: TableCell[] = [];
        $(tr)
          .children("td, th")
          .each((__, td) => {
            const inlines = walkInlines($, $(td));
            const cell: TableCell = {
              inlines,
              plainText: inlinesToPlainText(inlines),
            };
            if ($(td).is("th")) {
              cell.header = true;
            }
            row.push(cell);
          });
        if (row.length > 0) {
          rows.push(row);
        }
      });
      if (rows.length > 0) {
        chunks.push({ kind: "table", rows });
      }
      return;
    }

    if (tag === "p" || tag === "div") {
      flushBuffer();
      const centered = parentCentered || isCentered($node);
      const inlines = walkInlines($, $node);
      flushInlines(inlines, centered);
      return;
    }

    // List elements: flush buffer and process children as
    // block-level content. NS decisions use <ul> for quoted
    // passages; without this, text after closing </ul> merges
    // into the previous paragraph.
    if (tag === "ul" || tag === "ol") {
      flushBuffer();
      $node.contents().each((_, child) => {
        processNode(child, parentCentered);
      });
      flushBuffer();
      return;
    }

    if (tag === "li") {
      flushBuffer();
      $node.contents().each((_, child) => {
        processNode(child, parentCentered);
      });
      flushBuffer();
      return;
    }

    if (tag === "br") {
      // Top-level <br> between inline content: keep in buffer
      // as a line break so the text flows naturally.
      if (inlineBuffer.length > 0) {
        inlineBuffer.push({ type: "line-break" });
      }
      return;
    }

    // Inline-level at top level: accumulate into buffer
    const centered = parentCentered || isCentered($node);
    const inlines = walkInlines($, $node);

    if (tag === "b" || tag === "strong") {
      appendToBuffer([{ type: "bold", children: inlines }], centered);
      return;
    }

    appendToBuffer(inlines, centered);
  };

  const body = $("body");
  let afterTable = false;

  body.contents().each((_, node) => {
    if (isTag(node) && $(node).is("#box-table-a")) {
      afterTable = true;
      return;
    }
    if (!afterTable) {
      return;
    }
    processNode(node, false);
  });

  // Flush any remaining buffered inline content
  flushBuffer();

  return chunks;
};

// ── Pass 2: raw chunks -> semantic blocks ──────────────────

// ── Helpers (must precede classifyBlocks) ─────────────────

export const blocksToPlainText = (blocks: readonly Block[]): string =>
  blocks
    .map((block) => block.plainText)
    .join("\n\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

// ── Pattern constants ─────────────────────────────────────

const DECISION_TITLE_RE = /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]\s[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ\s]+$/u;

const DECISION_TYPE_WORDS = new Set([
  "ROZSUDEK",
  "USNESENÍ",
  "NÁLEZ",
  "STANOVISKO",
]);

// Matches "Odůvodnění", "O d ů v o d n ě n í",
// "Stručné odůvodnění (§ ...)", and spaced variants.
// Anchored to start of line to avoid false positives.
const SECTION_HEADING_RE =
  /^(?:S\s*t\s*r\s*u\s*[čc]\s*n\s*[ée]\s+)?O\s*d\s*[uů]\s*v\s*o\s*d\s*n\s*[eě]\s*n\s*[ií]/iu;

const RULING_ITEM_RE = /^(?:[IVXLCDM]+\.)\s+/u;

const isDecisionTitle = (plainText: string): boolean => {
  const trimmed = plainText.trim();
  if (DECISION_TITLE_RE.test(trimmed)) {
    return true;
  }
  return DECISION_TYPE_WORDS.has(trimmed);
};

const isSectionHeading = (plainText: string): boolean => {
  const firstLine = plainText.trim().split("\n").at(0)?.trim() ?? "";
  return SECTION_HEADING_RE.test(firstLine);
};

// ── Merge pass ────────────────────────────────────────────

const shouldMerge = (prev: Block, next: Block): prev is ParagraphBlock => {
  if (prev.type !== "paragraph") {
    return false;
  }
  if (next.type !== "paragraph") {
    return false;
  }

  const nextText = next.plainText.trim();
  if (!nextText) {
    return false;
  }

  // Never merge closing/signature blocks (either direction).
  // Length guard: PREDSEDA_RE (CZ_JUDGE_TITLE_RE) is unanchored
  // and would false-positive on body paragraphs mentioning
  // judicial titles; real signature lines are always short.
  const prevText = prev.plainText.trim();
  const isClosingOrSig = (text: string): boolean =>
    CLOSING_RE.test(text) ||
    SIGNATURE_RE.test(text) ||
    (text.length < 80 && PREDSEDA_RE.test(text));

  if (isClosingOrSig(prevText) || isClosingOrSig(nextText)) {
    return false;
  }

  const firstChar = nextText.at(0);
  if (!firstChar) {
    return false;
  }

  // Starts with comma, semicolon, or lone punctuation
  if (",;".includes(firstChar)) {
    return true;
  }

  // Very short fragment (continuation like "." or "se odmítá")
  if (nextText.length < 30 && !/[.!?:]\s*$/u.test(prevText)) {
    return true;
  }

  // Starts with lowercase = continuation
  if (
    firstChar === firstChar.toLowerCase() &&
    firstChar !== firstChar.toUpperCase()
  ) {
    return true;
  }

  return false;
};

const EMBEDDED_CASE_NUMBER_RE =
  /(?<!\w)(?<caseNumber>\d+\s+\w+\s+\d+\/\d{4}\S*)/u;
/** Capitals and spaces only, the way a caption prints its title lines. */
const CAPTION_TITLE_RE = /^[\p{Lu}\s]+$/u;
const MIN_CAPTION_TITLE_LETTERS = 5;

type EmbeddedCaption = {
  /** What precedes the case number: the court's name, or nothing. */
  preamble: string;
  caseNumber: string;
  /** Everything after the case number. */
  title: string;
};

/**
 * A caption stored as one paragraph, cut at its case number. The parts
 * together are the paragraph's text: nothing before, between or after them
 * is dropped. A paragraph whose text after the case number is not all
 * capitals is prose that cites a case, not a caption.
 */
const embeddedCaption = (text: string): EmbeddedCaption | null => {
  const match = EMBEDDED_CASE_NUMBER_RE.exec(text);
  const caseNumber = match?.groups?.["caseNumber"];
  if (match === null || caseNumber === undefined) {
    return null;
  }
  const title = text.slice(match.index + caseNumber.length).trim();
  const letters = title.match(/\p{L}/gu)?.length ?? 0;
  if (!CAPTION_TITLE_RE.test(title) || letters < MIN_CAPTION_TITLE_LETTERS) {
    return null;
  }
  return {
    preamble: text.slice(0, match.index).trim(),
    caseNumber,
    title,
  };
};

const mergeBlocks = (
  rawBlocks: Block[],
  makeBlockId: () => string,
): Block[] => {
  if (rawBlocks.length === 0) {
    return rawBlocks;
  }

  const merged: Block[] = [];

  for (const block of rawBlocks) {
    const prev = merged.at(-1);

    if (prev && block.type === "paragraph" && shouldMerge(prev, block)) {
      prev.inlines.push({ type: "text", text: " " }, ...block.inlines);
      prev.plainText = `${prev.plainText} ${block.plainText}`.trim();
      continue;
    }

    merged.push(block);
  }

  // Assign closing/signature roles to tail blocks only
  for (let i = merged.length - 1; i >= 0; i--) {
    const block = merged.at(i);
    if (!block) {
      continue;
    }
    if (block.type !== "paragraph") {
      break;
    }

    if (CLOSING_RE.test(block.plainText)) {
      block.role = "closing";
      continue;
    }
    if (
      SIGNATURE_RE.test(block.plainText) ||
      (block.plainText.length < 80 && PREDSEDA_RE.test(block.plainText))
    ) {
      block.role = "signature";
      continue;
    }
    break;
  }

  // Split the first paragraph if it contains an embedded
  // caption (older HTML: "NEJVYŠŠÍ SOUD ČESKÉ REPUBLIKY 29 Odo
  // 975/2006 U S N E S E N Í", "21 Cdo 4994/2007 ČESKÁ
  // REPUBLIKA ROZSUDEK JMÉNEM REPUBLIKY"): the court preamble
  // before the case number, the case number, and the capitals
  // after it as the title. Every character stays in a block.
  const firstParaIdx = merged.findIndex((b) => b.type === "paragraph");
  if (firstParaIdx !== -1) {
    const firstPara = merged.at(firstParaIdx);
    if (!firstPara) {
      return merged;
    }
    if (firstPara.type === "paragraph") {
      const caption = embeddedCaption(firstPara.plainText);

      if (caption !== null) {
        // The court's name keeps the block it was stored in.
        const preamble: Block[] =
          caption.preamble === ""
            ? []
            : [
                {
                  id: firstPara.id,
                  anchorId: firstPara.anchorId,
                  type: "paragraph",
                  inlines: [{ type: "text", text: caption.preamble }],
                  plainText: caption.preamble,
                },
              ];
        const replacements: Block[] = [
          ...preamble,
          {
            id: makeBlockId(),
            anchorId: `p-cn`,
            type: "paragraph",
            role: "case-number",
            inlines: [{ type: "text", text: caption.caseNumber }],
            plainText: caption.caseNumber,
          },
          {
            id: makeBlockId(),
            anchorId: `p-dt`,
            type: "heading",
            level: 1,
            role: "decision-title",
            inlines: [{ type: "text", text: caption.title }],
            plainText: caption.title,
          },
        ];
        merged.splice(firstParaIdx, 1, ...replacements);
      } else if (
        firstPara.plainText.length < 30 &&
        /^\d+\s+\w+\s+\d+\/\d{4}/u.test(firstPara.plainText)
      ) {
        firstPara.role = "case-number";
      }
    }
  }

  // Tag paragraphs in the holding zone (výrok): blocks
  // between the intro ending with "takto:" and the first
  // section heading (Odůvodnění). Ruling items already
  // have their own type; plain paragraphs in this zone
  // get role "holding".
  // Match "takto:", "takto :", "t a k t o :", etc.
  const TAKTO_RE = /t\s*a\s*k\s*t\s*o\s*(?::\s*)?$/iu;
  let inHolding = false;

  for (const block of merged) {
    if (!inHolding) {
      // Enter holding zone when a paragraph or heading
      // ends with "takto" (any spacing variant).
      const text = block.plainText.trim();
      if (TAKTO_RE.test(text)) {
        inHolding = true;
        continue;
      }
      continue;
    }

    // Exit holding zone at any heading (Odůvodnění or
    // other section headings — already detected by the
    // classifier via SECTION_HEADING_RE which handles
    // both "Odůvodnění" and "O d ů v o d n ě n í").
    if (block.type === "heading") {
      break;
    }
    if (block.type === "paragraph" && !block.role) {
      block.role = "holding";
    }
  }

  return merged;
};

// ── Classification ────────────────────────────────────────

const makeAnchorId = (index: number): string => `p-${index}`;

const classifyBlocks = (
  chunks: RawChunk[],
  relatedProceedingsTable: TableCell[][] | null,
): Block[] => {
  let blockCounter = 0;
  const makeBlockId = (): string => {
    blockCounter += 1;
    return `b${blockCounter}`;
  };
  const blocks: Block[] = [];
  let blockIndex = 0;

  if (relatedProceedingsTable) {
    blockIndex += 1;
    const plainText = relatedProceedingsTable
      .map((row) => row.map((cell) => cell.plainText).join("\t"))
      .join("\n");
    blocks.push({
      id: makeBlockId(),
      anchorId: makeAnchorId(blockIndex),
      type: "table",
      role: "related-proceedings",
      rows: relatedProceedingsTable,
      plainText,
    });
  }

  for (const chunk of chunks) {
    blockIndex += 1;
    const id = makeBlockId();
    const anchorId = makeAnchorId(blockIndex);

    if (chunk.kind === "table") {
      const plainText = chunk.rows
        .map((row) => row.map((cell) => cell.plainText).join("\t"))
        .join("\n");
      blocks.push({
        id,
        anchorId,
        type: "table",
        role: "related-proceedings",
        rows: chunk.rows,
        plainText,
      });
      continue;
    }

    const { inlines, centered } = chunk;
    const plainText = inlinesToPlainText(inlines).trim();

    if (!plainText) {
      continue;
    }

    // Decision title: centered all-caps
    if (centered && isDecisionTitle(plainText)) {
      blocks.push({
        id,
        anchorId,
        type: "heading",
        level: 1,
        role: "decision-title",
        inlines,
        plainText,
      });
      continue;
    }

    // Section heading: Odůvodnění
    if (isSectionHeading(plainText)) {
      blocks.push({
        id,
        anchorId,
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines,
        plainText,
      });
      continue;
    }

    // Centered non-title text: heading level 3
    // (but not closing/signature patterns)
    if (
      centered &&
      plainText.length < 100 &&
      !CLOSING_RE.test(plainText) &&
      !SIGNATURE_RE.test(plainText) &&
      !PREDSEDA_RE.test(plainText)
    ) {
      blocks.push({
        id,
        anchorId,
        type: "heading",
        level: 3,
        inlines,
        plainText,
      });
      continue;
    }

    // Ruling items: "I. ...", "II. ..." — detected by
    // Roman numeral prefix, emitted as holding paragraphs
    // with the full original text preserved.
    if (RULING_ITEM_RE.test(plainText)) {
      blocks.push({
        id,
        anchorId,
        type: "paragraph",
        role: "holding",
        inlines,
        plainText,
      });
      continue;
    }

    // Default: paragraph
    blocks.push({
      id,
      anchorId,
      type: "paragraph",
      inlines,
      plainText,
    });
  }

  return mergeBlocks(blocks, makeBlockId);
};
