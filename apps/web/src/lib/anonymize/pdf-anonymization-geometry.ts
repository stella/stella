import type { PDFPage } from "@libpdf/core";
import { Result } from "better-result";

import {
  findFileAnonymizationMatches,
  normalizeWhitespaceWithOffsets,
} from "@/lib/anonymize/file-anonymization-matches.logic";
import { ClientOperationError } from "@/lib/errors/client";
import { buildPageSearchText, mergePDFSearchBoxes } from "@/lib/pdf/pdf-search";
import type { PDFSearchBox } from "@/lib/pdf/pdf-search";

/**
 * Where anonymized text sits on a PDF page, for the on-screen overlay and the
 * redacted export alike. Both read one extraction in which every character
 * offset carries its own glyph box, so a term is located by its offsets and
 * nothing else: the overlay a reader sees is the mask the export burns in.
 */

/** One character's box, in PDF user space on its page. */
export type AnonymizationGlyph = { pageIndex: number; box: PDFSearchBox };

export type PdfAnonymizationText = {
  text: string;
  /** Per UTF-16 offset of `text`; `null` for separators with no glyph. */
  glyphs: (AnonymizationGlyph | null)[];
};

export const extractPdfAnonymizationText = (
  pages: readonly PDFPage[],
): PdfAnonymizationText => {
  const textParts: string[] = [];
  const glyphs: (AnonymizationGlyph | null)[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    if (pageIndex > 0) {
      textParts.push("\n");
      glyphs.push(null);
    }
    const extracted = buildPageSearchText(page.extractText());
    textParts.push(extracted.text);
    for (const box of extracted.boxesByOffset) {
      glyphs.push(box === null ? null : { pageIndex, box });
    }
  }
  return { text: textParts.join(""), glyphs };
};

/** A located occurrence: its offsets and the glyphs that draw it. */
type LocatedAnonymizationMatch = {
  start: number;
  end: number;
  glyphs: readonly AnonymizationGlyph[];
};

const isDrawableBox = (box: PDFSearchBox): boolean =>
  [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
  box.width > 0 &&
  box.height > 0;

/**
 * The glyphs of `[start, end)`. Fails closed: a visible character without a
 * drawable box would stay readable under the overlay and in the export, so
 * the whole location fails instead.
 */
const locateRange = (
  extraction: PdfAnonymizationText,
  start: number,
  end: number,
) => {
  const glyphs: AnonymizationGlyph[] = [];
  for (let offset = start; offset < end; offset += 1) {
    const glyph = extraction.glyphs[offset] ?? null;
    if (glyph === null) {
      if (/\s/u.test(extraction.text.charAt(offset))) {
        continue;
      }
      return Result.err(
        new ClientOperationError({
          action: "anonymization-geometry",
          message: "A matched character has no page coordinates",
        }),
      );
    }
    if (!isDrawableBox(glyph.box)) {
      return Result.err(
        new ClientOperationError({
          action: "anonymization-geometry",
          message: "A matched character has invalid page coordinates",
        }),
      );
    }
    glyphs.push(glyph);
  }
  return Result.ok(glyphs);
};

/** Every occurrence of `term`, matched the way detection matches it. */
export const locateAnonymizationTerm = (
  extraction: PdfAnonymizationText,
  term: string,
) => {
  const normalized = normalizeWhitespaceWithOffsets(extraction.text);
  const located: LocatedAnonymizationMatch[] = [];
  for (const { start, end } of findFileAnonymizationMatches(normalized, term)) {
    const glyphs = locateRange(extraction, start, end);
    if (glyphs.isErr()) {
      return glyphs;
    }
    if (glyphs.value.length > 0) {
      located.push({ start, end, glyphs: glyphs.value });
    }
  }
  return Result.ok(located);
};

/** Glyph boxes grouped by page and merged into one rectangle per run. */
export const glyphBoxesByPage = (
  glyphs: Iterable<AnonymizationGlyph>,
): Map<number, PDFSearchBox[]> => {
  const byPage = new Map<number, PDFSearchBox[]>();
  for (const { pageIndex, box } of glyphs) {
    const boxes = byPage.get(pageIndex);
    if (boxes) {
      boxes.push(box);
    } else {
      byPage.set(pageIndex, [box]);
    }
  }
  return new Map(
    [...byPage].map(([pageIndex, boxes]) => [
      pageIndex,
      mergePDFSearchBoxes(boxes),
    ]),
  );
};
