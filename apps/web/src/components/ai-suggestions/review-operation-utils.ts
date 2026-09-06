import { panic } from "better-result";

import type { FolioAIBlock, FolioAIEditOperation } from "@stll/folio-react";

export type ReviewOperationSnapshotBlock = Pick<
  FolioAIBlock,
  "id" | "text" | "styleId"
>;

export const isNoopReviewOperation = (
  operation: FolioAIEditOperation,
  blocksById: ReadonlyMap<string, ReviewOperationSnapshotBlock>,
): boolean => {
  switch (operation.type) {
    case "replaceInBlock":
      return operation.find === operation.replace;
    case "replaceBlock": {
      const block = blocksById.get(operation.blockId);
      const requestedStyleChanged =
        operation.styleId !== undefined && operation.styleId !== block?.styleId;
      return operation.text === (block?.text ?? "") && !requestedStyleChanged;
    }
    case "replaceRange": {
      const block = blocksById.get(operation.range.blockId);
      const selected = block?.text.slice(
        operation.range.startOffset,
        operation.range.endOffset,
      );
      return selected !== undefined && selected === operation.replace;
    }
    // Never a no-op against a text snapshot. A structural edit changes the
    // document's shape rather than a block's words, and `formatRange` /
    // `setBlockParagraphProperties` change formatting the snapshot does not
    // carry: it holds each block's text and style id, not its inline runs or
    // list level, so a comparison here could only ever be half of one.
    case "commentOnBlock":
    case "commentOnRange":
    case "deleteBlock":
    case "splitBlock":
    case "mergeBlockWithNext":
    case "formatRange":
    case "setBlockParagraphProperties":
    case "insertAfterBlock":
    case "insertBeforeBlock":
    case "insertSignatureTable":
    case "insertTable":
    case "deleteTable":
    case "insertTableRow":
    case "deleteTableRow":
    case "insertTableColumn":
    case "deleteTableColumn":
    case "mergeTableCells":
    case "splitTableCell":
      return false;
    default:
      operation satisfies never;
      return panic(`Unhandled operation: ${String(operation)}`);
  }
};
