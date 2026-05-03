/**
 * Unified citation primitives shared by:
 *  - extraction-cell justifications (table + metadata peek)
 *  - chat assistant messages
 *
 * The frontend always works with `Citation` regardless of where the
 * citation came from. The renderer emits chips, the workspace store
 * dispatches clicks, and the file-viewer wiring consumes them. A new
 * source (e.g. case-law decisions citing paragraphs) just needs to
 * map into this type.
 */

import type { JustificationContent } from "@/lib/types";

export type PdfBatesCitation = {
  kind: "pdf-bates";
  fileFieldId: string;
  bates: string;
  pageNumber: number;
};

export type DocxFolioCitation = {
  kind: "docx-folio";
  fileFieldId: string;
  blockId: string;
  /** Captured at extraction time; the renderer shows it as a quote
   *  so click-to-scroll is a navigation extra, not a prerequisite to
   *  seeing the source. */
  text: string;
};

export type Citation = PdfBatesCitation | DocxFolioCitation;

// Walk a justification content and yield every Citation in document
// order. `JustificationContent` already groups by `fileFieldId`, so
// we only flatten statements + cites.
export const iterateJustificationCitations = function* (
  content: JustificationContent,
): Generator<Citation> {
  for (const block of content.blocks) {
    if (block.kind === "pdf-bates") {
      for (const statement of block.statements) {
        for (const citation of statement.citations) {
          yield {
            kind: "pdf-bates",
            fileFieldId: block.fileFieldId,
            bates: citation.bates,
            pageNumber: citation.pageNumber,
          };
        }
      }
      continue;
    }
    for (const statement of block.statements) {
      for (const citation of statement.citations) {
        yield {
          kind: "docx-folio",
          fileFieldId: block.fileFieldId,
          blockId: citation.blockId,
          text: citation.text,
        };
      }
    }
  }
};
