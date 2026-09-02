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

/**
 * Every contract operation type. The headless apply renders nothing, so no
 * review-panel limitation narrows it; `formatRange`, `commentOnBlock`, and
 * `insertSignatureTable` are all valid there.
 */
const AUTO_APPLY_OPERATION_TYPES = [
  "replaceInBlock",
  "replaceRange",
  "commentOnRange",
  "formatRange",
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

/**
 * `suggest_changes` in the file overlay's automatic apply mode. The API
 * executes the batch against a headless reviewer and saves a new document
 * version, so nothing sorts by `severity` / `area` and they stay optional. The
 * API adds the per-request `documentVersion` pin at registration.
 */
export const DOCX_SUGGEST_CHANGES_AUTO_APPLY_OPTIONS = {
  operationTypes: AUTO_APPLY_OPERATION_TYPES,
  reviewMeta: "optional",
  maxOperations: 200,
} as const;
