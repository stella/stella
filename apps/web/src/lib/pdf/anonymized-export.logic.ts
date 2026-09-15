import type { PDFPage } from "@libpdf/core";
import { Result } from "better-result";

import {
  findFileAnonymizationMatches,
  normalizeWhitespaceWithOffsets,
} from "@/lib/anonymize/file-anonymization-matches.logic";
import { ClientOperationError } from "@/lib/errors/client";
import { buildPageSearchText, mergePDFSearchBoxes } from "@/lib/pdf/pdf-search";
import type { PDFSearchBox } from "@/lib/pdf/pdf-search";

type ExportGlyph = { pageIndex: number; box: PDFSearchBox };

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
    for (const { start, end } of findFileAnonymizationMatches(
      normalizedExtraction,
      term,
    )) {
      for (const glyph of extraction.glyphs.slice(start, end)) {
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
