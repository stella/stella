/**
 * The skill folders of this computer's local runs, as the native side reports
 * them (`local_skill_folders::SkillFolderStatus`).
 */

export const LOCAL_SKILL_FOLDERS_CHANGED_EVENT = "local-skill-folders-changed";

const SKILL_FOLDER_PROBLEMS = [
  "missing",
  "not_a_folder",
  "no_skill_file",
  "skill_file_not_regular",
  "skill_file_too_large",
  "unreadable",
  "no_name",
  "invalid_name",
  "duplicate_name",
  "runs_can_write",
  "network_folder",
  "path_changed",
] as const;
export type SkillFolderProblem = (typeof SKILL_FOLDER_PROBLEMS)[number];

const LIST_ERRORS = ["too_many", "already_listed"] as const;

export type SkillFolderNotice =
  (typeof LIST_ERRORS)[number] | SkillFolderProblem | "action_failed";

export type SkillFolderStatus = {
  path: string;
  skillName: string | null;
  problem: SkillFolderProblem | null;
};

const isProblem = (value: unknown): value is SkillFolderProblem =>
  SKILL_FOLDER_PROBLEMS.some((problem) => problem === value);

const isSkillFolderStatus = (value: unknown): value is SkillFolderStatus =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  typeof value.path === "string" &&
  "skillName" in value &&
  (value.skillName === null || typeof value.skillName === "string") &&
  "problem" in value &&
  (value.problem === null || isProblem(value.problem));

export const isSkillFolderList = (
  value: unknown,
): value is readonly SkillFolderStatus[] =>
  Array.isArray(value) && value.every(isSkillFolderStatus);

/** What to say about a refused command; Tauri rejects with its flat code. */
export const skillFolderNotice = (code: unknown): SkillFolderNotice => {
  if (isProblem(code)) {
    return code;
  }
  return LIST_ERRORS.find((known) => known === code) ?? "action_failed";
};
