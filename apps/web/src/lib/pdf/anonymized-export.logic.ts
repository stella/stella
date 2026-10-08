import { Result } from "better-result";

import {
  glyphBoxesByPage,
  locateAnonymizationTerm,
} from "@/lib/anonymize/pdf-anonymization-geometry";
import type { PdfAnonymizationText } from "@/lib/anonymize/pdf-anonymization-geometry";
import type { PDFSearchBox } from "@/lib/pdf/pdf-search";

type BuildAnonymizedExportMasksOptions = {
  extraction: PdfAnonymizationText;
  terms: readonly string[];
};

/**
 * The masks the export burns in: every occurrence of every term, per page.
 * Boxes merge within one occurrence only, so a mask never bridges two
 * occurrences across the unmatched text between them.
 */
export const buildAnonymizedExportMasks = ({
  extraction,
  terms,
}: BuildAnonymizedExportMasksOptions) => {
  const masks = new Map<number, PDFSearchBox[]>();
  for (const term of new Set(terms)) {
    const located = locateAnonymizationTerm(extraction, term);
    if (located.isErr()) {
      return Result.err(located.error);
    }
    for (const match of located.value) {
      for (const [pageIndex, boxes] of glyphBoxesByPage(match.glyphs)) {
        const pageMasks = masks.get(pageIndex);
        if (pageMasks) {
          pageMasks.push(...boxes);
        } else {
          masks.set(pageIndex, [...boxes]);
        }
      }
    }
  }
  return Result.ok(masks);
};
