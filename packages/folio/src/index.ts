export {
  DocxEditor,
  type DocxEditorProps,
  type DocxEditorRef,
  type EditorMode,
} from "./components/DocxEditor";
export {
  FormattingBar,
  type FormattingBarProps,
} from "./components/FormattingBar";
export {
  createEmptyDocument,
  type CreateEmptyDocumentOptions,
} from "./core/utils/createDocument";
export type { Document } from "./core/types/document";
export type { DocxCompatibility } from "./core/docx/compatibility";

// AI suggestion primitives — types, conflict resolution, apply, and
// the prosemirror decoration plugin. The bar/panel UI itself lives in
// apps/web; folio only ships the headless pieces.
export {
  DEFAULT_AI_SUGGESTION_PRESETS,
  type AICitation,
  type AICitationSource,
  type AIChatMode,
  type AISuggestion,
  type AISuggestionApplyMode,
  type AISuggestionPreset,
  type AISuggestionSeverity,
  type AISuggestionStatus,
  type AIBarStatus,
  type AIGenerateInput,
} from "./core/ai-suggestions/types";
export {
  applySuggestions,
  type ApplyResult,
} from "./core/ai-suggestions/apply";
export {
  applyFolioAIEditOperations,
  createFolioAIEditSnapshot,
  diffWordSegments,
  hashFolioAIBlockText,
  normalizeFolioAIBlockText,
  type WordDiffSegment,
  type FolioAIBlock,
  type FolioAIBlockAnchor,
  type FolioAIBlockKind,
  type FolioAIBlockPreviewRun,
  type FolioAIComment,
  type FolioAIEditAppliedOperation,
  type FolioAIEditApplyMode,
  type FolioAIEditApplyResult,
  type FolioAIEditOperation,
  type FolioAIEditReviewMeta,
  type FolioAIEditSeverity,
  type FolioAIEditSkipReason,
  type FolioAIEditSkippedOperation,
  type FolioAIEditSnapshot,
} from "./core/ai-edits";
export {
  resolveSuggestionAnchor,
  isSuggestionStale,
  type ResolvedAnchor,
} from "./core/ai-suggestions/conflict";
export {
  setAISuggestionsMeta,
  setFocusedSuggestionMeta,
} from "./core/prosemirror/plugins/aiSuggestionDecorations";
export {
  createAICitationDecorationsPlugin,
  setAICitationsMeta,
  setActiveCitationMeta,
  type AICitationRange,
} from "./core/prosemirror/plugins/aiCitationDecorations";
export {
  anonymizationDecorationsKey,
  setAnonymizationTermsMeta,
  type AnonymizationTerm,
} from "./core/prosemirror/plugins/anonymizationDecorations";
