/**
 * Shared utilities for parsers using libpdf/core.
 *
 * libpdf/core extracts PDF text with per-span font info
 * (bold, size, position). These helpers handle common
 * quirks: non-breaking spaces, word-splitting across spans,
 * and bold range mapping.
 */

// parser-output-unchanged: imports the document AST from its package owner
import type { Inline } from "@stll/legal-ast/document-ast";

// ── Types ────────────────────────────────────────────────

export type PdfSpan = {
  text: string;
  bbox: { x: number; width: number };
  fontSize: number;
  fontName: string;
};

type BoldRange = {
  start: number;
  end: number;
  bold: boolean;
};

type FontStyleRange = BoldRange & {
  italic: boolean;
};

// ── Text normalization ───────────────────────────────────

/**
 * Normalize text from libpdf/core spans.
 *
 * - Replace \u00A0 (non-breaking space) with regular space.
 *   libpdf uses &nbsp; within lines, which prevents the
 *   browser from wrapping at natural word boundaries.
 * - Collapse multiple spaces to single.
 * - Trim whitespace.
 */
export const normalizeSpanText = (text: string): string =>
  text
    .replace(/\u00A0/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();

// ── Bold detection ───────────────────────────────────────

export const isBoldFont = (fontName: string): boolean =>
  /bold/iu.test(fontName);

/**
 * Map font emphasis from individual spans onto a line's text.
 *
 * libpdf/core assembles `line.text` from spans with proper
 * word joining. We walk spans in order and track character
 * offsets by finding each span's text within the remaining
 * line text. This avoids reconstructing text from spans
 * (which breaks words split across multiple spans, e.g.,
 * "N" + "apadnuté" → "Napadnuté").
 *
 * Returns an array of ranges, each with start/end offsets
 * and font-style flags. Consecutive ranges of the same style are merged.
 */
export const buildFontStyleRanges = (
  spans: readonly PdfSpan[],
  lineText: string,
): FontStyleRange[] => {
  const ranges: FontStyleRange[] = [];
  let offset = 0;

  for (const span of spans) {
    const text = span.text.replace(/\u00A0/gu, " ");
    if (!text.trim()) {
      continue;
    }

    const bold = isBoldFont(span.fontName);
    const italic = /italic|oblique/iu.test(span.fontName);

    // Find this span's text in the remaining line text
    const pattern = text
      .trim()
      .split(/\s+/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("\\s+");
    const match = new RegExp(pattern, "u").exec(lineText.slice(offset));
    if (match === null) {
      continue;
    }

    const start = offset + match.index;
    const end = start + match[0].length;
    if (ranges.length === 0 && start > 0) {
      ranges.push({ start: 0, end: start, bold: false, italic: false });
    }

    // Merge only when both styles agree.
    const last = ranges.at(-1);
    if (last?.bold === bold && last.italic === italic) {
      last.end = end;
    } else {
      // Fill gaps with the preceding span's style.
      if (last && last.end < start) {
        last.end = start;
      }
      ranges.push({ start, end, bold, italic });
    }

    offset = end;
  }

  // Extend last range to end of line
  if (ranges.length > 0) {
    const lastRange = ranges.at(-1);
    if (lastRange) {
      lastRange.end = lineText.length;
    }
  } else if (lineText.trim()) {
    ranges.push({
      start: 0,
      end: lineText.length,
      bold: false,
      italic: false,
    });
  }

  return ranges;
};

/** Bold-only readers keep one range across an italic-only style change. */
export const buildBoldRanges = (
  spans: PdfSpan[],
  lineText: string,
): BoldRange[] => {
  const ranges: BoldRange[] = [];
  for (const { start, end, bold } of buildFontStyleRanges(spans, lineText)) {
    const previous = ranges.at(-1);
    if (previous?.bold === bold) {
      previous.end = end;
    } else {
      ranges.push({ start, end, bold });
    }
  }
  return ranges;
};

// ── Inline builders ──────────────────────────────────────

/** A text segment with optional bold and anonymization. */
export type PdfSegment = {
  text: string;
  bold?: true;
  anonymized?: true;
};

/**
 * Build inline AST nodes from segments.
 *
 * Each segment carries its own bold flag (from per-span
 * detection). Consecutive non-bold text segments merge
 * into one inline to reduce fragment count.
 */
export const segmentsToInlines = (
  segments: readonly PdfSegment[],
): Inline[] => {
  const inlines: Inline[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) {
      continue;
    }
    const prefix = i > 0 ? " " : "";

    if (seg.anonymized) {
      if (prefix && inlines.length > 0) {
        const last = inlines.at(-1);
        if (last?.type === "text" && !last.anonymized) {
          last.text += prefix;
        } else {
          inlines.push({ type: "text", text: prefix });
        }
      }
      inlines.push({
        type: "text",
        text: seg.text,
        anonymized: true,
      });
    } else if (seg.bold) {
      inlines.push({
        type: "bold",
        children: [{ type: "text", text: prefix + seg.text }],
      });
    } else {
      const last = inlines.at(-1);
      if (last?.type === "text" && !last.anonymized) {
        last.text += prefix + seg.text;
      } else {
        inlines.push({
          type: "text",
          text: prefix + seg.text,
        });
      }
    }
  }
  return inlines;
};
