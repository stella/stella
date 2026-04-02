/**
 * Shared utilities for parsers using libpdf/core.
 *
 * libpdf/core extracts PDF text with per-span font info
 * (bold, size, position). These helpers handle common
 * quirks: non-breaking spaces, word-splitting across spans,
 * and bold range mapping.
 */

import type { Inline } from "@/api/handlers/case-law/document-ast";

// ── Types ────────────────────────────────────────────────

export type PdfSpan = {
  text: string;
  bbox: { x: number; width: number };
  fontSize: number;
  fontName: string;
};

export type BoldRange = {
  start: number;
  end: number;
  bold: boolean;
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
    .replace(/\u00A0/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

// ── Bold detection ───────────────────────────────────────

export const isBoldFont = (fontName: string): boolean => /bold/i.test(fontName);

/**
 * Map bold state from individual spans onto a line's text.
 *
 * libpdf/core assembles `line.text` from spans with proper
 * word joining. We walk spans in order and track character
 * offsets by finding each span's text within the remaining
 * line text. This avoids reconstructing text from spans
 * (which breaks words split across multiple spans, e.g.,
 * "N" + "apadnuté" → "Napadnuté").
 *
 * Returns an array of ranges, each with start/end offsets
 * and a bold flag. Consecutive same-bold ranges are merged.
 */
export const buildBoldRanges = (
  spans: PdfSpan[],
  lineText: string,
): BoldRange[] => {
  const ranges: BoldRange[] = [];
  let offset = 0;

  for (const span of spans) {
    const text = span.text.replace(/\u00A0/g, " ");
    if (!text.trim()) {
      continue;
    }

    const bold = isBoldFont(span.fontName ?? "");

    // Find this span's text in the remaining line text
    const idx = lineText.indexOf(text.trim(), offset);
    if (idx === -1) {
      continue;
    }

    const start = idx;
    const end = idx + text.trim().length;

    // Merge with previous range if same bold state
    const last = ranges.at(-1);
    if (last && last.bold === bold) {
      last.end = end;
    } else {
      // Fill gap between ranges with previous bold state
      if (last && last.end < start) {
        last.end = start;
      }
      ranges.push({ start, end, bold });
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
    });
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
export const segmentsToInlines = (segments: PdfSegment[]): Inline[] => {
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
