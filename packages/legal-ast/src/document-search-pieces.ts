import { plainTextOf, tableCellPieceId } from "./document-ast";
import type { Block } from "./document-ast";

/**
 * A stretch of a block's text the reader renders as one piece: the unit a
 * find-bar match or a comparison mark is offset into.
 */
export type DocumentTextPiece = {
  id: string;
  text: string;
};

/** The piece a paragraph's hanging number is rendered as. */
export const getParagraphNumberPieceId = (blockId: string): string =>
  `paragraph-number:${blockId}`;

/**
 * Search pieces for a block list, in render order. Table cells get one
 * piece each so a match scrolls to the cell, and a hanging paragraph
 * number gets its own piece: folding it into the paragraph's text would
 * shift every highlight offset in that paragraph.
 */
export const buildDocumentAstSearchPieces = (
  blocks: readonly Block[],
): DocumentTextPiece[] => {
  const pieces: DocumentTextPiece[] = [];

  for (const block of blocks) {
    // A figure's only text is its alt, which is chrome for a screen
    // reader rather than the document's words: a find-bar hit on it
    // would scroll to a picture with nothing highlighted in it.
    if (block.type === "image") {
      continue;
    }

    if (block.type === "table") {
      for (const [rowIndex, row] of block.rows.entries()) {
        for (const [columnIndex, cell] of row.entries()) {
          pieces.push({
            id: tableCellPieceId({
              blockId: block.id,
              rowIndex,
              columnIndex,
            }),
            text: plainTextOf(cell.inlines),
          });
        }
      }
      continue;
    }

    pieces.push({ id: block.id, text: plainTextOf(block.inlines) });

    if (block.type === "paragraph" && block.number !== undefined) {
      pieces.push({
        id: getParagraphNumberPieceId(block.id),
        text: String(block.number),
      });
    }
  }

  return pieces;
};
