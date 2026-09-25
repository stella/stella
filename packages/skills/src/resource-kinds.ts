export const SKILL_RESOURCE_KINDS = [
  "asset",
  "knowledge",
  "prompt",
  "reference",
  "script",
  "template",
] as const;

export type SkillResourceKind = (typeof SKILL_RESOURCE_KINDS)[number];

const SKILL_RESOURCE_FOLDER_KINDS = {
  assets: "asset",
  knowledge: "knowledge",
  prompts: "prompt",
  reference: "reference",
  references: "reference",
  scripts: "script",
  templates: "template",
} as const satisfies Record<string, SkillResourceKind>;

const isSkillResourceFolder = (
  folder: string,
): folder is keyof typeof SKILL_RESOURCE_FOLDER_KINDS =>
  Object.hasOwn(SKILL_RESOURCE_FOLDER_KINDS, folder);

/**
 * Kind of a skill resource from its top-level folder, or null when the path
 * is not inside one of the skill package resource folders.
 */
export const getSkillResourceKind = (
  resourcePath: string,
): SkillResourceKind | null => {
  const root = resourcePath.split("/").at(0);
  if (root === undefined || !isSkillResourceFolder(root)) {
    return null;
  }
  return SKILL_RESOURCE_FOLDER_KINDS[root];
};
