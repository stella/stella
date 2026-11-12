/**
 * Link target prefix of a skill chip, the markdown link
 * `[label](#stella-skill-ref=slug)` prompt inputs write for a picked skill and
 * the API and chat renderer read back. A hash fragment, so Markdown sanitizers
 * keep it.
 */
export const SKILL_REF_HREF_PREFIX = "#stella-skill-ref=";

/**
 * A skill import could not fetch the source the person linked: the host was
 * unreachable, timed out or answered an error status (a private or missing
 * repository, a rate limit). Checking the link or retrying later answers it.
 */
export const SKILL_SOURCE_UNREACHABLE_CODE = "skill_source_unreachable";

/**
 * A skill resource refusal by size: the file's text is past what one stored
 * resource may hold, or past what a model may read in one piece (an AI
 * rewrite reads the whole file).
 */
export const SKILL_RESOURCE_REFUSAL_CODE = {
  tooLarge: "skill_resource_too_large",
  tooLargeForAi: "skill_resource_too_large_for_ai",
} as const;

/** Why a skill cannot be drafted from a chat. */
export const SKILL_FROM_CHAT_REFUSAL_CODE = {
  /** No chat of the caller's has this id in this scope. */
  threadNotFound: "skill_from_chat_thread_not_found",
  /** The chat was held anonymized; its stored text cannot be drafted from. */
  anonymizedThread: "skill_from_chat_anonymized_thread",
  /** The chat's content was withdrawn. */
  withdrawn: "skill_from_chat_withdrawn",
  /** The chat holds no text to learn a skill from yet. */
  emptyThread: "skill_from_chat_empty_thread",
} as const;

/**
 * The kinds of name a skill draft is checked for before it is stored. A name
 * in a skill reaches everyone the skill is shared with, so the author approves
 * each one.
 */
export const SKILL_DRAFT_NAME_KINDS = ["person", "organization"] as const;

export type SkillDraftNameKind = (typeof SKILL_DRAFT_NAME_KINDS)[number];

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
