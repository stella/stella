/**
 * Slovak Courts PDF parser.
 *
 * Extracts structured DocumentAst from court decision PDFs
 * using @libpdf/core's text extraction with line/font info.
 *
 * libpdf/core provides:
 *   - Per-line text with bounding boxes
 *   - Font name per span (Arial-BoldMT vs ArialMT)
 *   - Font size per span (20pt title vs 10pt body)
 *
 * This is far richer than unpdf's mergePages plaintext; it
 * gives us real line breaks and bold detection without
 * heuristics.
 *
 * SK court PDFs have a consistent structure:
 *
 *   Súd: ...                          (header, skipped)
 *   Spisová značka: ...               (header, skipped)
 *   ECLI: ...                         (header, skipped)
 *
 *   Uznesenie                         (title, large font)
 *
 *   Court name ... takto              (intro)
 *   r o z h o d o l :                 (bold, section heading)
 *   I. ...                            (holding)
 *   II. ...                           (holding)
 *
 *   o d ô v o d n e n i e :           (bold, section heading)
 *   1. ...                            (reasoning)
 *   2. ...                            (reasoning)
 *
 *   P o u č e n i e :                 (bold, section heading)
 *   ...
 *
 *   V {City} dňa ...                  (closing)
 *   Mgr. ...                          (signature)
 */

import { PDF } from "@libpdf/core";

import type {
  Block,
  DocumentAst,
  Inline,
} from "@/api/handlers/case-law/document-ast";
import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/handlers/case-law/ingestion/parsers/validate-ast";

// ── Public API ─────────────────────────────────────────────

export type ParseSkDecisionInput = {
  /** Raw PDF bytes. */
  pdfBytes: Uint8Array;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
};

export type ParseSkDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

type PdfLine = {
  text: string;
  bold: boolean;
  fontSize: number;
};

export const parseSkDecisionPdf = async (
  input: ParseSkDecisionInput,
): Promise<ParseSkDecisionOutput> => {
  const lines = await extractLines(input.pdfBytes);
  const filtered = skipHeaderLines(lines);
  const blocks = classifyLines(filtered);

  // Synthesize decision title if none detected
  const hasTitle = blocks.some(
    (b) => b.type === "heading" && b.role === "decision-title",
  );
  if (!hasTitle && input.decisionType) {
    const title =
      input.decisionType.charAt(0).toUpperCase() + input.decisionType.slice(1);
    blocks.unshift({
      id: "b0",
      anchorId: "h-title",
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: [{ type: "text", text: title }],
      plainText: title,
    });
  }

  const validationHtml = buildValidationHtml(filtered.map((l) => l.text));
  validateAndLog("sk-courts", input.caseNumber, validationHtml, blocks);

  const fulltext = blocks
    .map((b) => b.plainText)
    .filter(Boolean)
    .join("\n\n");

  const ast: DocumentAst = {
    version: 1,
    source: {
      system: "obcan.justice.sk",
      documentId: input.caseNumber,
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: input.caseNumber,
      ecli: input.ecli ?? null,
      court: input.court,
      decisionDate: input.decisionDate ?? null,
      decisionType: input.decisionType ?? null,
      keywords: [],
      statutes: [],
    },
    blocks,
  };

  return { documentAst: ast, fulltext };
};

// ── PDF extraction ────────────────────────────────────────

const isBoldFont = (fontName: string): boolean => /bold/i.test(fontName);

/**
 * Extract lines from all PDF pages using @libpdf/core.
 * Each line carries text, bold flag, and font size.
 */
const extractLines = async (pdfBytes: Uint8Array): Promise<PdfLine[]> => {
  const pdf = await PDF.load(pdfBytes);
  const pages = pdf.getPages();
  const lines: PdfLine[] = [];

  for (const page of pages) {
    const result = page.extractText();
    for (const line of result.lines) {
      const text = line.text.trim();
      if (!text) {
        continue;
      }

      // Determine if line is bold from primary span's font
      const primarySpan = line.spans[0];
      const bold = primarySpan ? isBoldFont(primarySpan.fontName ?? "") : false;
      const fontSize = primarySpan?.fontSize ?? 10;

      lines.push({ text, bold, fontSize });
    }
  }

  return mergeWrappedLines(lines);
};

/**
 * PDF text extraction gives one entry per visual line (page
 * wrap). Merge consecutive lines that are continuations of
 * the same paragraph: same font, same bold, not a structural
 * marker (numbered item, section heading, title).
 */
/**
 * Patterns that always start a new paragraph during line
 * merging. Closing/signature patterns are NOT here because
 * judge titles (JUDr., Mgr.) and city names appear in
 * intro text too; those are only treated as signatures
 * when they appear after the instruction section.
 */
const STARTS_NEW_PARAGRAPH_RE =
  /^(?:\d{1,3}\.\s|(?:I{1,3}|IV|VI{0,3}|IX|X)\.\s|\([a-z]\)\s)/u;

function isStructuralStart(line: PdfLine): boolean {
  if (line.fontSize > 14) {
    return true; // title
  }
  if (STARTS_NEW_PARAGRAPH_RE.test(line.text)) {
    return true;
  }
  const norm = normalizeSpaced(line.text.toLowerCase().trim());
  if (
    HOLDING_MARKERS.some((m) => norm.endsWith(m)) ||
    REASONING_MARKERS.some((m) => norm === m) ||
    INSTRUCTION_MARKERS.some((m) => norm === m)
  ) {
    return true;
  }
  if (DECISION_TITLES.has(line.text.toLowerCase().trim())) {
    return true;
  }
  return false;
}

const mergeWrappedLines = (lines: PdfLine[]): PdfLine[] => {
  const merged: PdfLine[] = [];

  for (const line of lines) {
    const prev = merged.at(-1);

    // Start a new paragraph if:
    // - first line
    // - bold changed
    // - font size changed
    // - line is a structural start (numbered, section marker)
    // - previous line was bold (section markers are standalone)
    const startNew =
      !prev ||
      line.bold !== prev.bold ||
      line.fontSize !== prev.fontSize ||
      isStructuralStart(line) ||
      prev.bold;

    if (startNew) {
      merged.push({ ...line });
    } else {
      // Continuation: append text to previous paragraph
      prev.text += ` ${line.text}`;
    }
  }

  return merged;
};

// ── Header stripping ──────────────────────────────────────

/** Header labels that repeat API metadata; skip from body. */
const HEADER_LABELS = [
  "Súd:",
  "Spisová značka:",
  "Identifikačné číslo",
  "Dátum vydania",
  "Meno a priezvisko",
  "ECLI:",
];

const isHeaderLine = (text: string): boolean =>
  HEADER_LABELS.some((label) => text.startsWith(label));

const skipHeaderLines = (lines: PdfLine[]): PdfLine[] => {
  // Skip header lines at the start of the document
  let i = 0;
  while (i < lines.length && isHeaderLine(lines[i]?.text ?? "")) {
    i++;
  }
  return lines.slice(i);
};

// ── Classification ────────────────────────────────────────

/** Decision type names that appear as standalone title lines. */
const DECISION_TITLES = new Set([
  "uznesenie",
  "rozsudok",
  "rozsudok bez odôvodnenia",
  "trestný rozkaz",
  "príkaz",
  "rozhodnutie",
  "uznesenie bez odôvodnenia",
]);

/**
 * Collapse spaced-out letters for marker detection.
 * Same logic as pipeline.ts collapseSpacedLetters;
 * duplicated here to avoid circular imports.
 * Canonical location: pipeline.ts SPACED_WORD regex.
 */
const SPACED_WORD_RE =
  /(?<=\s|^)(\p{L} (?:\p{L} )*\p{L})( ?[,:;.!?])?(?=\s|$)/gu;

const normalizeSpaced = (text: string): string =>
  text
    .replace(SPACED_WORD_RE, (match) => match.replace(/ /g, ""))
    .replace(/ {2,}/g, " ");

const HOLDING_MARKERS = ["rozhodol:", "rozhodol :", "rozhodla:", "rozhodlo:"];

const REASONING_MARKERS = ["odôvodnenie:", "odôvodnenie :"];

const INSTRUCTION_MARKERS = ["poučenie:", "poučenie :"];

const isHoldingMarker = (text: string): boolean => {
  const norm = normalizeSpaced(text.toLowerCase().trim());
  return HOLDING_MARKERS.some((m) => norm.endsWith(m));
};

const isReasoningMarker = (text: string): boolean => {
  const norm = normalizeSpaced(text.toLowerCase().trim());
  return REASONING_MARKERS.some((m) => norm === m);
};

const isInstructionMarker = (text: string): boolean => {
  const norm = normalizeSpaced(text.toLowerCase().trim());
  return INSTRUCTION_MARKERS.some((m) => norm === m);
};

/** Closing formula: "V {City} dňa ..." */
/** Closing formula: "V {City} dňa ..." or "Vo {City} dňa ..." */
const CLOSING_RE = /^Vo?\s+\p{Lu}\p{Ll}+\s+dňa\s/u;

/** Judge signature: title prefix */
const SIGNATURE_RE =
  /^(?:JUDr\.|Mgr\.|doc\.|Ing\.|PhDr\.|RNDr\.|MUDr\.|PaedDr\.)\s/;

const createIdGenerator = (): (() => string) => {
  let counter = 0;
  return () => `b${++counter}`;
};

const textInline = (text: string): Inline[] => [{ type: "text", text }];

const boldInline = (text: string): Inline[] => [
  { type: "bold", children: [{ type: "text", text }] },
];

type Section = "preamble" | "holding" | "reasoning" | "instruction";

/**
 * Classify extracted PDF lines into AST blocks.
 *
 * Bold and font size come directly from PDF font metadata;
 * no heuristic regex splitting needed.
 */
const classifyLines = (lines: PdfLine[]): Block[] => {
  const makeId = createIdGenerator();
  let blockCount = 0;
  const blocks: Block[] = [];
  let section: Section = "preamble";

  for (const line of lines) {
    const { text, bold, fontSize } = line;

    // Decision title: large font or matching decision type
    if (
      section === "preamble" &&
      (fontSize > 14 || DECISION_TITLES.has(text.toLowerCase().trim()))
    ) {
      blocks.push({
        id: makeId(),
        anchorId: "h-title",
        type: "heading",
        level: 1,
        role: "decision-title",
        inlines: [{ type: "text", text }],
        plainText: text,
      });
      continue;
    }

    // Bold section markers (rozhodol, odôvodnenie, poučenie)
    if (bold && isHoldingMarker(text)) {
      section = "holding";
      blocks.push({
        id: makeId(),
        anchorId: "h-holding",
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: boldInline(text),
        plainText: text,
      });
      continue;
    }

    if (bold && isReasoningMarker(text)) {
      section = "reasoning";
      blocks.push({
        id: makeId(),
        anchorId: "h-reasoning",
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: boldInline(text),
        plainText: text,
      });
      continue;
    }

    if (bold && isInstructionMarker(text)) {
      section = "instruction";
      blocks.push({
        id: makeId(),
        anchorId: "h-instruction",
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: boldInline(text),
        plainText: text,
      });
      continue;
    }

    // Closing formula and judge signature only apply after
    // the instruction (poučenie) section. Judge titles like
    // JUDr., Mgr. appear in intro text (senate composition)
    // and must not be classified as signatures there.
    if (section === "instruction" && CLOSING_RE.test(text)) {
      blocks.push({
        id: makeId(),
        anchorId: `p${++blockCount}`,
        type: "paragraph",
        role: "closing",
        inlines: textInline(text),
        plainText: text,
      });
      continue;
    }

    if (section === "instruction" && SIGNATURE_RE.test(text)) {
      blocks.push({
        id: makeId(),
        anchorId: `p${++blockCount}`,
        type: "paragraph",
        role: "signature",
        inlines: textInline(text),
        plainText: text,
      });
      continue;
    }

    // Regular paragraph with section-appropriate role
    const inlines = bold ? boldInline(text) : textInline(text);

    const block: Block = {
      id: makeId(),
      anchorId: `p${++blockCount}`,
      type: "paragraph",
      inlines,
      plainText: text,
    };

    if (section === "holding") {
      block.role = "holding";
    } else if (section === "preamble" && blocks.length <= 1) {
      block.role = "intro";
    }

    blocks.push(block);
  }

  return blocks;
};
