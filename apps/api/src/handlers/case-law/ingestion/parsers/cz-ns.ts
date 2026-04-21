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
import type { AnyNode } from "domhandler";

import type {
  Block,
  DocumentAst,
  DocumentAstMetadata,
  Inline,
  TableCell,
} from "@/api/handlers/case-law/document-ast";

import {
  CZ_CLOSING_RE as CLOSING_RE,
  CZ_JUDGE_NAME_RE as SIGNATURE_RE,
  CZ_JUDGE_TITLE_RE as PREDSEDA_RE,
} from "./cz-patterns";

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
  sourceMetadata: Record<string, unknown>;
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

const parseDominoDate = (raw: string): string | null => {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!match) {
    return null;
  }
  const [, month, day, year] = match;
  // SAFETY: regex guarantees 3 capture groups
  return `${year}-${month?.padStart(2, "0") ?? ""}-${day?.padStart(2, "0") ?? ""}`;
};

type MetadataResult = {
  canonical: DocumentAstMetadata;
  source: Record<string, unknown>;
  relatedProceedingsTable: TableCell[][] | null;
};

export const extractNsMetadata = ($: cheerio.CheerioAPI): MetadataResult => {
  const canonical: DocumentAstMetadata = {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  };
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- metadata accumulator, not a DB update
  const source: Record<string, unknown> = {};
  let relatedProceedingsTable: TableCell[][] | null = null;

  const splitBrValues = (td: cheerio.Cheerio<AnyNode>) =>
    ($(td).html() ?? "")
      .split(/<br\s*\/?>/i)
      .map((s) => cheerio.load(s).text().trim())
      .filter(Boolean);

  const metaTable = $("#box-table-a");
  metaTable.find("> tbody > tr, > tr").each((_, tr) => {
    const tds = $(tr).find("> td");
    if (tds.length < 2) {
      const singleTd = $(tr).find("> td");
      if (
        singleTd.length === 1 &&
        singleTd.text().includes("ústavní stížnost")
      ) {
        const nestedTable = singleTd.find("table");
        if (nestedTable.length > 0) {
          const rows: TableCell[][] = [];
          nestedTable.find("tr").each((__, innerTr) => {
            const row: TableCell[] = [];
            $(innerTr)
              .find("td")
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
              const entry: Record<string, string> = {};
              for (let i = 0; i < headers.length; i++) {
                const h = headers[i] ?? `col${i}`;
                entry[h] = row[i]?.plainText.trim() ?? "";
              }
              return entry;
            });
          }
        }
      }
      return;
    }

    const labelText = $(tds[0]).text().trim();
    const valueText = $(tds[1]).text().trim();

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
    if (labelText.includes("Spisová značka")) {
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
      source.kategorieRozhodnuti = valueText.trim();
      return;
    }
    if (labelText.includes("Zveřejněno na webu")) {
      source.zverejnenoNaWebu = parseDominoDate(valueText) ?? valueText;
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
): Inline[] => {
  const inlines: Inline[] = [];

  el.contents().each((_, node) => {
    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type === "text") {
      const text = $(node).text();
      if (text) {
        inlines.push({ type: "text", text });
      }
      return;
    }

    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type !== "tag") {
      return;
    }

    const tag = node.tagName.toLowerCase();
    const $node = $(node);

    if (tag === "br") {
      inlines.push({ type: "line-break" });
      return;
    }

    if (tag === "b" || tag === "strong") {
      const children = walkInlines($, $node);
      if (children.length > 0) {
        inlines.push({ type: "bold", children });
      }
      return;
    }

    if (tag === "i" || tag === "em") {
      const children = walkInlines($, $node);
      if (children.length > 0) {
        inlines.push({ type: "italic", children });
      }
      return;
    }

    if (tag === "a") {
      const href = $node.attr("href");
      const children = walkInlines($, $node);
      if (href && children.length > 0) {
        inlines.push({ type: "link", href, children });
      } else if (children.length > 0) {
        inlines.push(...children);
      }
      return;
    }

    // Unwrap presentational wrappers
    inlines.push(...walkInlines($, $node));
  });

  return inlines;
};

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

  const metaTable = $("#box-table-a");
  let siblings = metaTable.nextAll();

  if (siblings.length === 0) {
    const body = $("body");
    let foundTable = false;
    siblings = body.children().filter((_, el) => {
      if ($(el).is("#box-table-a")) {
        foundTable = true;
        return false;
      }
      return foundTable;
    });
  }

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
    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type === "text") {
      const text = $(node).text();
      if (text.trim()) {
        appendToBuffer([{ type: "text", text }], parentCentered);
      }
      return;
    }

    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type !== "tag") {
      return;
    }

    const tag = node.tagName.toLowerCase();
    const $node = $(node);

    if (tag === "style" || tag === "script" || tag === "input") {
      return;
    }

    // Block-level elements: flush buffer, then process
    if (tag === "table") {
      flushBuffer();
      const rows: TableCell[][] = [];
      $node.find("tr").each((_, tr) => {
        const row: TableCell[] = [];
        $(tr)
          .find("td")
          .each((__, td) => {
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
      // children() (elements only) avoids raw text nodes
      // inside <ul> leaking into the preceding chunk.
      $node.children().each((_, child) => {
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
    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type === "tag" && $(node).is("#box-table-a")) {
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

const inlinesToPlainText = (inlines: readonly Inline[]): string => {
  let text = "";
  for (const inline of inlines) {
    switch (inline.type) {
      case "text": {
        text += inline.text;
        break;
      }
      case "bold":
      case "italic": {
        text += inlinesToPlainText(inline.children);
        break;
      }
      case "link": {
        text += inlinesToPlainText(inline.children);
        break;
      }
      case "line-break": {
        text += "\n";
        break;
      }
      default:
        break;
    }
  }
  return text;
};

export const blocksToPlainText = (blocks: readonly Block[]): string =>
  blocks
    .map((block) => block.plainText)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ── Pattern constants ─────────────────────────────────────

const DECISION_TITLE_RE = /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ\s]+$/;

const DECISION_TYPE_WORDS = ["ROZSUDEK", "USNESENÍ", "NÁLEZ", "STANOVISKO"];

// Matches "Odůvodnění", "O d ů v o d n ě n í",
// "Stručné odůvodnění (§ ...)", and spaced variants.
// Anchored to start of line to avoid false positives.
const SECTION_HEADING_RE =
  /^(?:S\s*t\s*r\s*u\s*[čc]\s*n\s*[ée]\s+)?O\s*d\s*[uů]\s*v\s*o\s*d\s*n\s*[eě]\s*n\s*[ií]/i;

const RULING_ITEM_RE = /^([IVXLCDM]+\.)\s+/;

const isDecisionTitle = (plainText: string): boolean => {
  const trimmed = plainText.trim();
  if (DECISION_TITLE_RE.test(trimmed)) {
    return true;
  }
  return DECISION_TYPE_WORDS.includes(trimmed);
};

const isSectionHeading = (plainText: string): boolean => {
  const firstLine = plainText.trim().split("\n").at(0)?.trim() ?? "";
  return SECTION_HEADING_RE.test(firstLine);
};

// ── Merge pass ────────────────────────────────────────────

type InlineBlock = Exclude<Block, { type: "table" }>;

const shouldMerge = (prev: Block, next: Block): prev is InlineBlock => {
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
  if (nextText.length < 30 && !/[.!?:]\s*$/.test(prevText)) {
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
  // decision title (older HTML: "NEJVYŠŠÍ SOUD ... 29 Odo
  // 975/2006 U S N E S E N Í"). Extract the case number
  // and title; drop the court preamble.
  const firstParaIdx = merged.findIndex((b) => b.type === "paragraph");
  if (firstParaIdx !== -1) {
    const firstPara = merged.at(firstParaIdx);
    if (!firstPara) {
      return merged;
    }
    if (firstPara.type === "paragraph") {
      const text = firstPara.plainText;
      // Check for embedded title
      const titleMatch =
        /([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ\s]{5,})\s*$/.exec(text);
      const caseMatch = /(\d+\s+\w+\s+\d+\/\d{4}[^\s]*)/.exec(text);

      if (titleMatch && caseMatch) {
        // Replace the merged block with case-number + title
        const caseNum = (caseMatch[1] ?? "").trim();
        const title = (titleMatch[1] ?? "").trim();

        const replacements: Block[] = [
          {
            id: makeBlockId(),
            anchorId: `p-cn`,
            type: "paragraph",
            role: "case-number",
            inlines: [{ type: "text", text: caseNum }],
            plainText: caseNum,
          },
          {
            id: makeBlockId(),
            anchorId: `p-dt`,
            type: "heading",
            level: 1,
            role: "decision-title",
            inlines: [{ type: "text", text: title }],
            plainText: title,
          },
        ];
        merged.splice(firstParaIdx, 1, ...replacements);
      } else if (
        firstPara.plainText.length < 30 &&
        /^\d+\s+\w+\s+\d+\/\d{4}/.test(firstPara.plainText)
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
  const TAKTO_RE = /t\s*a\s*k\s*t\s*o\s*:?\s*$/i;
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
    if (inHolding) {
      if (block.type === "heading") {
        break;
      }
      if (block.type === "paragraph" && !block.role) {
        block.role = "holding";
      }
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
