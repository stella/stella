/**
 * Why an uploaded package file was left out of the installed skill. A package
 * keeps files in any folder now; `unsupported-folder` stays only because
 * upload records written before still carry it. `unsupported-extension` is a
 * file whose extension says it is binary, `not-utf8-text` one whose bytes are
 * not UTF-8 text.
 */
export const SKIPPED_SKILL_FILE_REASON = {
  OUTSIDE_SKILL_FOLDER: "outside-skill-folder",
  UNSUPPORTED_FOLDER: "unsupported-folder",
  UNSUPPORTED_EXTENSION: "unsupported-extension",
  NOT_UTF8_TEXT: "not-utf8-text",
} as const;

export type SkippedSkillFileReason =
  (typeof SKIPPED_SKILL_FILE_REASON)[keyof typeof SKIPPED_SKILL_FILE_REASON];

export type SkippedSkillFile = {
  /** The file's path inside the uploaded package. */
  path: string;
  reason: SkippedSkillFileReason;
};
