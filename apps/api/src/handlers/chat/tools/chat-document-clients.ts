import {
  DOCX_SUGGESTION_SURFACE,
  type DocxSuggestionSurface,
} from "@stll/api-contract/chat-docx-suggestions";

export type ChatDocumentClients = {
  /** Which client executor resolves `suggest_changes`. */
  docxSuggestionSurface: DocxSuggestionSurface;
  /** A review queue that resolves `suggest_changes` is mounted. */
  hasActiveDocxEditClient: boolean;
  /** The file overlay's live-editor bridge is mounted. */
  hasActiveDocxFileClient: boolean;
};

/**
 * The document clients a chat turn has, from the documents its request
 * carries. A send and the composer's skill-availability check both derive
 * the chat tool set's document inputs here, so the two cannot disagree on
 * which document tools a chat with a given document open registers.
 */
export const resolveChatDocumentClients = ({
  activeFileSupportsDocxEdits,
  hasActiveDraft,
  hasActiveTemplate,
}: {
  /** An open file whose editor accepts DOCX edits (`activeFile.supportsDocxEdits`). */
  activeFileSupportsDocxEdits: boolean;
  hasActiveDraft: boolean;
  hasActiveTemplate: boolean;
}): ChatDocumentClients => ({
  // Only Template Studio narrows `suggest_changes` to text replacements;
  // the file overlay hosts both entity-backed files and unsaved generated
  // drafts with the full operation set.
  docxSuggestionSurface: hasActiveTemplate
    ? DOCX_SUGGESTION_SURFACE.templateStudio
    : DOCX_SUGGESTION_SURFACE.fileOverlay,
  hasActiveDocxEditClient:
    activeFileSupportsDocxEdits || hasActiveDraft || hasActiveTemplate,
  // Narrower than the edit client: only the file overlay mounts the watcher
  // that resolves the folio-agents `read_document` / `find_text` tools.
  hasActiveDocxFileClient: activeFileSupportsDocxEdits,
});
