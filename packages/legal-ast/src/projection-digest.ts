import { panic } from "better-result";
/**
 * The text a reader renders, as the pieces spans are stored against.
 *
 * A piece is one inline run the reader renders under one id: a heading or
 * paragraph under its block id, a table cell under `tableCellPieceId`. Block
 * ids are counters of one parse, so an offset into a piece means something
 * only beside the digest of the projection it was computed on; two ASTs
 * with the same digest place every span identically.
 */

import { sha256Hex as hashSha256Hex } from "@stll/sha256/browser";

import { plainTextOf, tableCellPieceId } from "./document-ast.js";
import type { Block, DocumentAst } from "./document-ast.js";

/**
 * Bumped with any change to piece enumeration, piece ids, `plainTextOf` or
 * the digest encoding. The pinned fixture digest in the tests fails until
 * it is, so stored digests never silently change meaning.
 */
export const PROVISION_SPAN_PROJECTION_REVISION = 1;

export type ProjectionPiece = {
  pieceId: string;
  text: string;
};

const piecesOfBlock = (block: Block): ProjectionPiece[] => {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [{ pieceId: block.id, text: plainTextOf(block.inlines) }];
    case "table":
      return block.rows.flatMap((row, rowIndex) =>
        row.map((cell, columnIndex) => ({
          pieceId: tableCellPieceId({
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

/** Every piece of the document in reading order, table cells row-major. */
export const projectionPieces = (
  ast: Pick<DocumentAst, "blocks">,
): ProjectionPiece[] => ast.blocks.flatMap(piecesOfBlock);

/**
 * SHA-256, as lowercase hex, of the projection revision and every piece's
 * `(pieceId, text)` in document order. The encoding is a JSON array, which
 * escapes every string the same way on every runtime (lone surrogates
 * included), so the digest is a pure function of the pieces.
 */
export const projectionDigest = async (
  ast: Pick<DocumentAst, "blocks">,
): Promise<string> => {
  const encoded = JSON.stringify([
    PROVISION_SPAN_PROJECTION_REVISION,
    projectionPieces(ast).map(({ pieceId, text }) => [pieceId, text]),
  ]);
  return await hashSha256Hex(encoded);
};
