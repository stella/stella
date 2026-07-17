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
    case "commentOnBlock":
    case "commentOnRange":
    case "deleteBlock":
    case "formatRange":
    case "insertAfterBlock":
    case "insertBeforeBlock":
    case "insertSignatureTable":
    case "insertTableRow":
    case "deleteTableRow":
    case "insertTableColumn":
    case "deleteTableColumn":
    case "mergeTableCells":
    case "splitTableCell":
      return false;
    default:
      operation satisfies never;
      return false;
  }
};
