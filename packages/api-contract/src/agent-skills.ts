/**
 * Link target prefix of a skill chip, the markdown link
 * `[label](#stella-skill-ref=slug)` prompt inputs write for a picked skill and
 * the API and chat renderer read back. A hash fragment, so Markdown sanitizers
 * keep it.
 */
export const SKILL_REF_HREF_PREFIX = "#stella-skill-ref=";

/** Browser-safe path grammar shared by skill-resource producers and editors. */
export const SKILL_RESOURCE_PATH_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;

/**
 * The document a chat composer has open, as far as the chat's tools care:
 * an entity-backed file in the editor, an unsaved generated draft, or a
 * template in Template Studio.
 */
export const CHAT_SKILL_DOCUMENT = {
  draft: "draft",
  file: "file",
  template: "template",
} as const;

export type ChatSkillDocument =
  (typeof CHAT_SKILL_DOCUMENT)[keyof typeof CHAT_SKILL_DOCUMENT];

/**
 * What a chat would have to change for a skill to become available in it:
 * send without anonymization, turn on web search, open a document, have the
 * open document's AI edits queued for review, open the chat in a matter, or
 * connect the browser extension.
 */
export const CHAT_SKILL_CONTEXT_NEED = {
  browserExtension: "browser_extension",
  document: "document",
  matter: "matter",
  rawSendMode: "raw_send_mode",
  reviewEdits: "review_edits",
  webSearch: "web_search",
} as const;

export type ChatSkillContextNeed =
  (typeof CHAT_SKILL_CONTEXT_NEED)[keyof typeof CHAT_SKILL_CONTEXT_NEED];
