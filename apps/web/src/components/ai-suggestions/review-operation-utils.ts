import type { FolioAIBlock, FolioAIEditOperation } from "@stll/folio";

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
    case "commentOnBlock":
    case "deleteBlock":
    case "insertAfterBlock":
    case "insertBeforeBlock":
    case "insertSignatureTable":
      return false;
    default:
      operation satisfies never;
      return false;
  }
};
