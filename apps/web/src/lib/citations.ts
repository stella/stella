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

/**
 * A DOCX citation, discriminated by whether its quote was grounded
 * against an allow-listed source block server-side.
 *
 * - `verified`: the quote matched a real block. It carries the block's
 *   literal `text` (shown as the quote) and the `blockId` the renderer
 *   navigates to; click-to-scroll is a navigation extra, not a
 *   prerequisite to seeing the source.
 * - `unverified`: the model's quote matched no source block. There is no
 *   navigable block, so the renderer shows the raw `text` as a
 *   non-clickable hint — an unverified citation is a hint, not a source.
 */
export type DocxFolioCitation =
  | {
      kind: "docx-folio";
      citationStatus: "verified";
      fileFieldId: string;
      blockId: string;
      text: string;
    }
  | {
      kind: "docx-folio";
      citationStatus: "unverified";
      fileFieldId: string;
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
    // Verdict blocks carry a rationale, not document citations.
    if (block.kind === "playbook-verdict") {
      continue;
    }
    for (const statement of block.statements) {
      for (const citation of statement.citations) {
        // Legacy justifications persisted before the verified/unverified
        // split have no `citationStatus`; they were allow-listed at write
        // time, so treat the absence as verified.
        if (citation.citationStatus === "unverified") {
          yield {
            kind: "docx-folio",
            citationStatus: "unverified",
            fileFieldId: block.fileFieldId,
            text: citation.text,
          };
          continue;
        }
        yield {
          kind: "docx-folio",
          citationStatus: "verified",
          fileFieldId: block.fileFieldId,
          blockId: citation.blockId,
          text: citation.text,
        };
      }
    }
  }
};
