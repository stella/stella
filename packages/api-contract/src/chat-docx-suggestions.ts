/**
 * Per-surface shape of the folio-agents `suggest_changes` tool. The API
 * registers the tool and builds the prompt from these options; the web
 * client executes the tool with the same options, so schema, parser, and
 * prompt cannot drift. Plain data, so the contract package stays free of a
 * folio dependency; the values are structurally a `FolioSuggestChangesOptions`.
 */

export const DOCX_SUGGESTION_SURFACE = {
  /** File overlay: suggestions queue into the review panel. */
  fileOverlay: "file-overlay",
  /** Template Studio: suggestions become in-document text replacements. */
  templateStudio: "template-studio",
} as const;

export type DocxSuggestionSurface =
  (typeof DOCX_SUGGESTION_SURFACE)[keyof typeof DOCX_SUGGESTION_SURFACE];

/** Operations every surface queues; `formatRange` waits on a review-panel rendering for formatting hunks. */
const FILE_OVERLAY_OPERATION_TYPES = [
  "replaceInBlock",
  "replaceRange",
  "commentOnRange",
  "insertAfterBlock",
  "insertBeforeBlock",
  "replaceBlock",
  "deleteBlock",
  "commentOnBlock",
  "insertSignatureTable",
  "insertTableRow",
  "deleteTableRow",
  "insertTableColumn",
  "deleteTableColumn",
  "mergeTableCells",
  "splitTableCell",
] as const;

/** The Studio renders suggestions as text replacements only. */
const TEMPLATE_STUDIO_OPERATION_TYPES = [
  "replaceInBlock",
  "replaceBlock",
  "deleteBlock",
] as const;

/** Both review surfaces sort and group by `severity` / `area`, so the model must set them. */
export const DOCX_SUGGEST_CHANGES_OPTIONS_BY_SURFACE = {
  [DOCX_SUGGESTION_SURFACE.fileOverlay]: {
    operationTypes: FILE_OVERLAY_OPERATION_TYPES,
    reviewMeta: "required",
    maxOperations: 200,
  },
  [DOCX_SUGGESTION_SURFACE.templateStudio]: {
    operationTypes: TEMPLATE_STUDIO_OPERATION_TYPES,
    reviewMeta: "required",
    maxOperations: 200,
  },
} as const;
