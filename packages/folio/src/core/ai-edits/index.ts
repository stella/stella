export { applyFolioAIEditOperations } from "./apply";
export {
  createFolioAIEditSnapshot,
  hashFolioAIBlockText,
  normalizeFolioAIBlockText,
} from "./snapshot";
export { diffWordSegments } from "./word-diff";
export type { WordDiffSegment } from "./word-diff";
export type {
  FolioAIBlock,
  FolioAIBlockAnchor,
  FolioAIBlockKind,
  FolioAIComment,
  FolioAIEditAppliedOperation,
  FolioAIEditApplyMode,
  FolioAIEditApplyResult,
  FolioAIEditOperation,
  FolioAIEditReviewMeta,
  FolioAIEditSeverity,
  FolioAIEditSkipReason,
  FolioAIEditSkippedOperation,
  FolioAIEditSnapshot,
} from "./types";
