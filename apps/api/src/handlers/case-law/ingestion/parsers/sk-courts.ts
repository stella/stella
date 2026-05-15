/**
 * Slovak Courts PDF parser.
 *
 * Extracts structured DocumentAst from court decision PDFs
 * using libpdf/core's text extraction with line/font info.
 *
 * libpdf/core provides:
 *   - Per-line text with bounding boxes
 *   - Font name per span (Arial-BoldMT vs ArialMT)
 *   - Font size per span (20pt title vs 10pt body)
 *
 * Per-line extraction gives us real line breaks and bold
 * detection without heuristics.
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
  buildBoldRanges,
  isBoldFont,
  normalizeSpanText,
  segmentsToInlines,
} from "@/api/handlers/case-law/ingestion/parsers/libpdf-utils";
import type {
  PdfSegment,
  PdfSpan,
} from "@/api/handlers/case-law/ingestion/parsers/libpdf-utils";
import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/handlers/case-law/ingestion/parsers/validate-ast";

// ── Public API ─────────────────────────────────────────────

type ParseSkDecisionInput = {
  /** Raw PDF bytes. */
  pdfBytes: Uint8Array;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  /** Override for source.system in the AST. */
  sourceSystem?: string;
};

type ParseSkDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

type PdfLine = {
  text: string;
  segments: PdfSegment[];
  /** True when the PRIMARY (first) span is bold. Used for
   *  structural detection (section markers, headings). */
  bold: boolean;
  fontSize: number;
  /** 0-based page index from PDF extraction. */
  pageIndex: number;
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
      system: input.sourceSystem ?? "obcan.justice.sk",
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

/** Placeholder text for redacted (anonymized) spans. */
const ANONYMIZED_PLACEHOLDER = "anonymizované";

/**
 * Extract lines from all PDF pages using libpdf/core.
 * Each line carries text, bold flag, font size, and
 * segments with anonymization markers for redaction gaps.
 */
const extractLines = async (pdfBytes: Uint8Array): Promise<PdfLine[]> => {
  const pdf = await PDF.load(pdfBytes);
  const pages = pdf.getPages();
  const lines: PdfLine[] = [];

  for (const [pageIdx, page] of pages.entries()) {
    const result = page.extractText();

    // Detect left margin from most common line start X.
    const leftMargin = detectLeftMargin(result.lines);

    for (const line of result.lines) {
      // Build per-span segments with bold info and
      // redaction gap detection.
      const segments = buildSpanSegments(
        line.spans,
        { ...line.bbox, text: line.text },
        leftMargin,
      );
      if (segments.length === 0) {
        continue;
      }

      const text = segments
        .map((s) => s.text)
        .join(" ")
        .replace(/ {2,}/g, " ")
        .trim();
      if (!text) {
        continue;
      }

      const primarySpan = line.spans[0];
      const bold = primarySpan ? isBoldFont(primarySpan.fontName) : false;
      const fontSize = primarySpan?.fontSize ?? 10;

      lines.push({
        text,
        segments,
        bold,
        fontSize,
        pageIndex: pageIdx,
      });
    }
  }

  // Strip page numbers BEFORE merging — otherwise they
  // get joined into the preceding paragraph's text.
  const withoutPageNumbers = lines.filter((line) => !isPageNumber(line, lines));

  return mergeWrappedLines(withoutPageNumbers);
};

type PdfTextLine = {
  spans: PdfSpan[];
  bbox: { x: number; width: number };
};

/**
 * Detect the most common left margin on a page.
 * Most body text lines start at the same X position;
 * lines starting further right have leading redaction.
 */
const detectLeftMargin = (lines: readonly PdfTextLine[]): number => {
  const xCounts = new Map<number, number>();
  for (const line of lines) {
    if (line.spans.length === 0) {
      continue;
    }
    // Round to integer to group similar positions
    const x = Math.round(line.bbox.x);
    xCounts.set(x, (xCounts.get(x) ?? 0) + 1);
  }
  let bestX = 70; // reasonable default
  let bestCount = 0;
  for (const [x, count] of xCounts) {
    if (count > bestCount) {
      bestX = x;
      bestCount = count;
    }
  }
  return bestX;
};

/**
 * Minimum gap (in points) for redaction detection.
 * SK ÚS PDFs redact names with black rectangles that
 * libpdf/core renders as missing text or large
 * whitespace spans.
 */
const REDACTION_MIN_GAP = 50;

/**
 * Build segments from individual PDF spans, preserving
 * per-span bold info and detecting redaction gaps.
 *
 * Each non-whitespace span becomes a segment with its own
 * bold flag. Consecutive spans with the same bold state
 * are merged to reduce fragment count.
 *
 * Redaction detection:
 * 1. Leading gap: line starts far from left margin AND
 *    begins with punctuation (continuation after redaction)
 * 2. Trailing whitespace: wide empty span at line end
 */
type LineBbox = {
  x: number;
  width: number;
  text: string;
};

const buildSpanSegments = (
  spans: PdfSpan[],
  lineBbox: LineBbox,
  leftMargin: number,
): PdfSegment[] => {
  if (spans.length === 0) {
    return [];
  }

  const segments: PdfSegment[] = [];

  // 1. Leading redaction gap
  const firstTextSpan = spans.find((s) => normalizeSpanText(s.text) !== "");
  if (firstTextSpan) {
    const firstText = normalizeSpanText(firstTextSpan.text);
    const leadingGap = lineBbox.x - leftMargin;
    const startsWithContinuation = /^[,;.)\s]/.test(firstText);
    if (leadingGap > REDACTION_MIN_GAP && startsWithContinuation) {
      segments.push({
        text: ANONYMIZED_PLACEHOLDER,
        anonymized: true,
      });
    }
  }

  // 2. Build per-span segments with bold info.
  //    Use line.text (properly joined by libpdf/core)
  //    for content, and map character offsets to spans
  //    for bold detection. Building text from individual
  //    spans breaks words that @libpdf splits across
  //    multiple spans (e.g., "N" + "apadnuté").
  const lineText = normalizeSpanText(lineBbox.text);
  if (lineText) {
    // Build a bold map: for each char offset, is it bold?
    // Walk spans and line text in parallel.
    const boldRanges = buildBoldRanges(spans, lineText);

    for (const range of boldRanges) {
      const chunk = lineText.slice(range.start, range.end);
      if (!chunk.trim()) {
        continue;
      }
      const seg: PdfSegment = { text: chunk.trim() };
      if (range.bold) {
        seg.bold = true;
      }
      segments.push(seg);
    }
  }

  // 3. Trailing redaction: wide whitespace at end
  const totalTextLen = segments
    .filter((s) => !s.anonymized)
    .reduce((sum, s) => sum + s.text.length, 0);
  if (spans.length > 0 && totalTextLen >= 30) {
    const lastSpan = spans.at(-1);
    if (
      lastSpan &&
      !lastSpan.text.trim() &&
      lastSpan.bbox.width > REDACTION_MIN_GAP
    ) {
      segments.push({
        text: ANONYMIZED_PLACEHOLDER,
        anonymized: true,
      });
    }
  }

  // Clean up: trim each segment text
  for (const seg of segments) {
    seg.text = seg.text.replace(/ {2,}/g, " ").trim();
  }

  return segments.filter((s) => s.text !== "");
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
// Roman numeral pattern excludes case citations like
// "II. ÚS 177/04" via negative lookahead for "ÚS".
const STARTS_NEW_PARAGRAPH_RE =
  /^(?:\d{1,3}\.\s|(?:I{1,3}|IV|VI{0,3}|IX|X)\.(?:\s(?!ÚS\b)|$)|\([a-z]\)\s)/u;

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
    // startsWith: SK ÚS PDFs put "Poučenie:" inline with
    // text on the same line, not as a standalone heading.
    INSTRUCTION_MARKERS.some((m) => norm === m || norm.startsWith(m))
  ) {
    return true;
  }
  if (DECISION_TITLES.has(line.text.toLowerCase().trim())) {
    return true;
  }
  // Closing formula and signature always start a new block
  if (CLOSING_RE.test(line.text)) {
    return true;
  }
  if (SIGNATURE_RE.test(line.text)) {
    return true;
  }
  return false;
}

const mergeWrappedLines = (lines: readonly PdfLine[]): PdfLine[] => {
  const merged: PdfLine[] = [];

  for (const line of lines) {
    const prev = merged.at(-1);

    // Start a new paragraph if:
    // - first line
    // - bold changed
    // - font size changed
    // - line is a structural start (numbered, section marker)
    // - previous line was bold (section markers are standalone)
    // Font size tolerance: libpdf/core may report
    // slightly different sizes across pages (e.g., 10.0
    // vs 9.98) due to PDF matrix rounding.
    const fontSizeChanged =
      Math.abs(line.fontSize - (prev?.fontSize ?? 0)) > 0.5;

    // SK ÚS PDFs sometimes bold a short continuation
    // (e.g., "zrušuje.", "1 014,41 eur ...") that belongs
    // to the preceding non-bold paragraph. Allow merging
    // when: prev is non-bold, current is bold but not a
    // section marker. This preserves the prev.bold rule
    // that prevents merging after section headings.
    const boldContinuation =
      prev &&
      !prev.bold &&
      line.bold &&
      !fontSizeChanged &&
      !isStructuralStart(line);

    const startNew =
      !prev ||
      (line.bold !== prev.bold && !boldContinuation) ||
      fontSizeChanged ||
      isStructuralStart(line) ||
      prev.bold;

    if (startNew) {
      merged.push({
        ...line,
        segments: [...line.segments],
      });
    } else {
      // Continuation: append text and segments.
      // Keep latest pageIndex for page boundary detection.
      prev.text += ` ${line.text}`;
      prev.segments.push(...line.segments);
      prev.pageIndex = line.pageIndex;
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

const skipHeaderLines = (lines: readonly PdfLine[]): PdfLine[] => {
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
  // startsWith: SK ÚS PDFs put "Poučenie:" inline with
  // text on the same line, not as a standalone heading.
  return INSTRUCTION_MARKERS.some((m) => norm === m || norm.startsWith(m));
};

/**
 * Closing formula:
 *   "V {City} dňa ..."   (obcan.justice.sk)
 *   "V {City} {date}"    (ustavnysud.sk, no "dňa")
 *   "Vo {City} ..."      (locative variant)
 */
const CLOSING_RE = /^Vo?\s+\p{Lu}\p{Ll}+\s+(?:dňa\s|\d{1,2}\.\s)/u;

/** Judge signature: title prefix */
const SIGNATURE_RE =
  /^(?:JUDr\.|Mgr\.|doc\.|Ing\.|PhDr\.|RNDr\.|MUDr\.|PaedDr\.)\s/;

const createIdGenerator = (): (() => string) => {
  let counter = 0;
  return () => `b${++counter}`;
};

const boldInline = (text: string): Inline[] => [
  { type: "bold", children: [{ type: "text", text }] },
];

type Section = "preamble" | "holding" | "reasoning" | "instruction" | "closing";

/**
 * Detect page numbers using PDF page boundary info.
 *
 * A standalone number is a page number when it's the first
 * or last line on its PDF page (page headers/footers).
 * This is more robust than matching digit patterns alone.
 */
const isPageNumber = (line: PdfLine, allLines: readonly PdfLine[]): boolean => {
  if (!/^\d{1,4}$/.test(line.text.trim())) {
    return false;
  }
  if (line.bold) {
    return false;
  }

  const idx = allLines.indexOf(line);
  if (idx === -1) {
    return false;
  }

  // First line on this page
  const prevLine = allLines[idx - 1];
  if (!prevLine || prevLine.pageIndex !== line.pageIndex) {
    return true;
  }

  // Last line on this page
  const nextLine = allLines[idx + 1];
  if (!nextLine || nextLine.pageIndex !== line.pageIndex) {
    return true;
  }

  return false;
};

/**
 * Classify extracted PDF lines into AST blocks.
 *
 * Bold and font size come directly from PDF font metadata;
 * no heuristic regex splitting needed.
 */
const classifyLines = (lines: readonly PdfLine[]): Block[] => {
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
        inlines: segmentsToInlines(line.segments),
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
      const norm = normalizeSpaced(text.toLowerCase().trim());
      const isStandalone = INSTRUCTION_MARKERS.some((m) => norm === m);
      if (isStandalone) {
        blocks.push({
          id: makeId(),
          anchorId: "h-instruction",
          type: "heading",
          level: 2,
          role: "section-heading",
          inlines: boldInline(text),
          plainText: text,
        });
      } else {
        // Inline "Poučenie:" with body text following
        // (common in SK ÚS PDFs). Emit as paragraph.
        blocks.push({
          id: makeId(),
          anchorId: `p${++blockCount}`,
          type: "paragraph",
          inlines: segmentsToInlines(line.segments),
          plainText: text,
        });
      }
      continue;
    }

    // Closing formula and judge signature only apply after
    // the instruction (poučenie) section. Judge titles like
    // JUDr., Mgr. appear in intro text (senate composition)
    // and must not be classified as signatures there.
    if (section === "instruction" && CLOSING_RE.test(text)) {
      section = "closing";
      blocks.push({
        id: makeId(),
        anchorId: `p${++blockCount}`,
        type: "paragraph",
        role: "closing",
        inlines: segmentsToInlines(line.segments),
        plainText: text,
      });
      continue;
    }

    // After the closing formula, everything is signature
    // material (judge name, title). Standalone numbers
    // are page numbers — drop them entirely.
    if (section === "closing") {
      // Drop page numbers (standalone digits)
      if (/^\d{1,3}$/.test(text.trim())) {
        continue;
      }
      blocks.push({
        id: makeId(),
        anchorId: `p${++blockCount}`,
        type: "paragraph",
        role: "signature",
        inlines: segmentsToInlines(line.segments),
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
        inlines: segmentsToInlines(line.segments),
        plainText: text,
      });
      continue;
    }

    // Standalone bold Roman numeral markers (I., II., III.)
    // are sub-section dividers. Classify as level 3 headings
    // so they render as visual separators, not plain paragraphs.
    if (bold && /^(?:I{1,3}|IV|VI{0,3}|IX|X{1,3})\.$/u.test(text.trim())) {
      blocks.push({
        id: makeId(),
        anchorId: `p${++blockCount}`,
        type: "heading",
        level: 3,
        inlines: boldInline(text),
        plainText: text,
      });
      continue;
    }

    // Short bold line after a Roman numeral heading is a
    // sub-section title (e.g., "Ústavná sťažnosť",
    // "Argumentácia sťažovateľa"). Center it as h3.
    const prevBlock = blocks.at(-1);
    if (
      bold &&
      text.length < 80 &&
      prevBlock?.type === "heading" &&
      prevBlock.level === 3
    ) {
      blocks.push({
        id: makeId(),
        anchorId: `p${++blockCount}`,
        type: "heading",
        level: 3,
        inlines: segmentsToInlines(line.segments),
        plainText: text,
      });
      continue;
    }

    // Regular paragraph with section-appropriate role
    const inlines = segmentsToInlines(line.segments);

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
