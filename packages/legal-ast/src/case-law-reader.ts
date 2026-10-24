import { panic } from "better-result";

import { normalizeCaseLawDecisionAst } from "./case-law-normalize.js";
import {
  type Block,
  type DocumentAst,
  parseUsableDocumentAst,
  plainTextOf,
  tableCellPieceId,
} from "./document-ast.js";

/** Parse persisted case-law content and apply every read-time structural repair. */
export const parseCaseLawDecisionAst = (raw: unknown): DocumentAst | null => {
  const ast = parseUsableDocumentAst(raw);
  return ast === null ? null : normalizeCaseLawDecisionAst(ast);
};

/** A run of words the reader renders under its own `data-anchor`. */
type ReaderAnchorPiece = { anchorId: string; text: string };

/**
 * The anchored pieces a reader selection can land in, each with the text
 * its offsets index. A table is anchored per cell, an image not at all.
 */
export const readerAnchorPiecesOf = (block: Block): ReaderAnchorPiece[] => {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [{ anchorId: block.anchorId, text: plainTextOf(block.inlines) }];
    case "table":
      return block.rows.flatMap((row, rowIndex) =>
        row.map((cell, columnIndex) => ({
          anchorId: tableCellPieceId({
            blockId: block.id,
            columnIndex,
            rowIndex,
          }),
          text: plainTextOf(cell.inlines),
        })),
      );
    case "image":
      return [];
    default:
      block satisfies never;
      return panic(`Unhandled block type: ${String(block)}`);
  }
};
