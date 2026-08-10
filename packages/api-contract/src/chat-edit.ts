/**
 * Which DOCX-edit review surface a chat turn uses. Manual queues suggestions
 * for browser review; auto applies edits server-side and writes a new version.
 */
export const CHAT_EDIT_APPLY_MODE = {
  manual: "manual",
  auto: "auto",
} as const;

export type ChatEditApplyMode =
  (typeof CHAT_EDIT_APPLY_MODE)[keyof typeof CHAT_EDIT_APPLY_MODE];

/** The redline representation used by server-applied DOCX edits. */
export const DOCX_EDIT_REPRESENTATION = {
  trackedChanges: "tracked-changes",
  direct: "direct",
} as const;

export type DocxEditRepresentation =
  (typeof DOCX_EDIT_REPRESENTATION)[keyof typeof DOCX_EDIT_REPRESENTATION];

export const DEFAULT_CHAT_EDIT_APPLY_MODE = CHAT_EDIT_APPLY_MODE.auto;

export const DEFAULT_DOCX_EDIT_REPRESENTATION =
  DOCX_EDIT_REPRESENTATION.trackedChanges;
