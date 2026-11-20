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
 * A skill resource refusal: an unsafe path, a DOCX or PDF whose text cannot
 * be read, or a file's text past what one stored resource may hold or past
 * what a model may read in one piece (an AI rewrite reads the whole file).
 */
export const SKILL_RESOURCE_REFUSAL_CODE = {
  pathInvalid: "skill_resource_path_invalid",
  textUnreadable: "skill_resource_text_unreadable",
  tooLarge: "skill_resource_too_large",
  tooLargeForAi: "skill_resource_too_large_for_ai",
} as const;

/**
 * Why a skill package was refused: its manifest is unreadable or from a
 * newer format, a file it lists is missing or changed, or the skill's files
 * together exceed what one skill may hold.
 */
export const SKILL_PACKAGE_REFUSAL_CODE = {
  fileChanged: "skill_package_file_changed",
  fileMissing: "skill_package_file_missing",
  formatUnsupported: "skill_package_format_unsupported",
  manifestInvalid: "skill_package_manifest_invalid",
  tooLarge: "skill_package_too_large",
} as const;

/**
 * File name extensions a skill package is offered under. Both name the same
 * zip archive; an import reads the bytes, not the name.
 * `@stll/skills/package` holds the same formats.
 */
export const SKILL_PACKAGE_FILE_EXTENSIONS = [".zip", ".skill"] as const;

/** Why a skill cannot be drafted from a chat. */
export const SKILL_FROM_CHAT_REFUSAL_CODE = {
  /** No chat of the caller's has this id in this scope. */
  threadNotFound: "skill_from_chat_thread_not_found",
  /** The chat runs on the member's computer; no cloud model reads it. */
  localRunThread: "skill_from_chat_local_run_thread",
  /** The chat was held anonymized; its stored text cannot be drafted from. */
  anonymizedThread: "skill_from_chat_anonymized_thread",
  /** The chat's content was withdrawn. */
  withdrawn: "skill_from_chat_withdrawn",
  /** The chat holds no text to learn a skill from yet. */
  emptyThread: "skill_from_chat_empty_thread",
} as const;

/**
 * A skill package request (a chat package tool, a skill export) named a
 * skill the caller cannot reach: absent, in another organization, or not
 * theirs to read or edit.
 */
export const SKILL_PACKAGE_SKILL_NOT_FOUND_CODE =
  "skill_package_skill_not_found";

/** A skill holds more than one archive download may carry. */
export const SKILL_EXPORT_TOO_LARGE_CODE = "skill_export_too_large";

/**
 * The kinds of name a skill draft is checked for before it is stored. A name
 * in a skill reaches everyone the skill is shared with, so the author approves
 * each one.
 */
export const SKILL_DRAFT_NAME_KINDS = ["person", "organization"] as const;

export type SkillDraftNameKind = (typeof SKILL_DRAFT_NAME_KINDS)[number];

/**
 * Path grammar for a skill resource, shared by producers and editors: any
 * folder and case (the Agent Skills spec allows any files beside SKILL.md),
 * relative, no empty, `.` or `..` segment, no control or format characters,
 * no backslash or any of `< > : " | ? *`, no segment that starts or ends with whitespace
 * or ends with a dot. `@stll/skills/format` holds the same pattern.
 */
export const SKILL_RESOURCE_PATH_PATTERN =
  /^(?!\.[sS][tT][eE][lL][lL][aA](?:\/|$))(?!\.\.?(?:\/|$))[^\s/\\<>:"|?*\p{Cc}\p{Cf}](?:[^/\\<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*[^\s./\\<>:"|?*\p{Cc}\p{Cf}])?(?:\/(?!\.\.?(?:\/|$))[^\s/\\<>:"|?*\p{Cc}\p{Cf}](?:[^/\\<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*[^\s./\\<>:"|?*\p{Cc}\p{Cf}])?)*$/u;

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
