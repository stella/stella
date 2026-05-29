/**
 * Server-only entry for `@stll/folio`.
 *
 * Type re-exports (folio block data shapes) plus the small set of
 * DOM-free runtime helpers servers need to PRODUCE ids that round-
 * trip through the editor — sharing `deriveBlockId` here is what
 * keeps the server DOCX parser and the in-browser snapshot from
 * minting incompatible block ids.
 *
 * Anything DOM-dependent stays on the main `@stll/folio` entry.
 */
export type {
  FolioAIBlock,
  FolioAIBlockAnchor,
  FolioAIBlockKind,
  FolioAIBlockPreviewRun,
  FolioAIEditSnapshot,
} from "./core/ai-edits/types";
export {
  deriveBlockId,
  getFolioParaIdFromBlockId,
  isFolioBlockId,
  isSequentialFolioBlockId,
  type DeriveBlockIdInput,
  type FolioBlockId,
} from "./core/types/block-id";
