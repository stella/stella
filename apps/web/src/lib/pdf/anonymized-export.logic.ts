import type { PDFPage } from "@libpdf/core";
import { Result } from "better-result";

import { findSearchMatchRanges } from "@stll/text-normalize";

import { ClientOperationError } from "@/lib/errors/client";
import { buildPageSearchText, mergePDFSearchBoxes } from "@/lib/pdf/pdf-search";
import type { PDFSearchBox } from "@/lib/pdf/pdf-search";

type ExportGlyph = { pageIndex: number; box: PDFSearchBox };

type NormalizedText = { text: string; originalBoundaries: number[] };

export const normalizeWhitespaceWithOffsets = (
  text: string,
): NormalizedText => {
  const normalized: string[] = [];
  const originalBoundaries = [0];
  let index = 0;
  while (index < text.length) {
    if (/\s/u.test(text[index] ?? "")) {
      while (index < text.length && /\s/u.test(text[index] ?? "")) {
        index += 1;
      }
      normalized.push(" ");
      originalBoundaries.push(index);
      continue;
    }
    normalized.push(text[index] ?? "");
    index += 1;
    originalBoundaries.push(index);
  }
  return { text: normalized.join(""), originalBoundaries };
};

export const extractAnonymizedExportText = (pages: readonly PDFPage[]) => {
  const textParts: string[] = [];
  const glyphs: (ExportGlyph | null)[] = [];
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

type BuildAnonymizedExportMasksOptions = {
  extraction: ReturnType<typeof extractAnonymizedExportText>;
  terms: readonly string[];
};

export const buildAnonymizedExportMasks = ({
  extraction,
  terms,
}: BuildAnonymizedExportMasksOptions) => {
  const normalizedExtraction = normalizeWhitespaceWithOffsets(extraction.text);
  const selected = new Set<ExportGlyph>();
  for (const term of new Set(terms)) {
    const normalizedTerm = term.replace(/\s+/gu, " ").trim();
    if (normalizedTerm.length === 0) {
      continue;
    }
    for (const { start, end } of findSearchMatchRanges(
      normalizedExtraction.text,
      normalizedTerm,
    )) {
      const originalStart = normalizedExtraction.originalBoundaries[start];
      const originalEnd = normalizedExtraction.originalBoundaries[end];
      if (originalStart === undefined || originalEnd === undefined) {
        continue;
      }
      for (const glyph of extraction.glyphs.slice(originalStart, originalEnd)) {
        if (glyph !== null) {
          selected.add(glyph);
        }
      }
    }
  }
  const boxesByPage = new Map<number, PDFSearchBox[]>();
  for (const { pageIndex, box } of selected) {
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width < 0 ||
      box.height <= 0
    ) {
      return Result.err(
        new ClientOperationError({
          action: "anonymized-export",
          message: "A matched character has invalid page coordinates",
        }),
      );
    }
    const boxes = boxesByPage.get(pageIndex);
    if (boxes) {
      boxes.push(box);
    } else {
      boxesByPage.set(pageIndex, [box]);
    }
  }
  return Result.ok(
    new Map(
      [...boxesByPage].map(([pageIndex, boxes]) => [
        pageIndex,
        mergePDFSearchBoxes(boxes),
      ]),
    ),
  );
};
