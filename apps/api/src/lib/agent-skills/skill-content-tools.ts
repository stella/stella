export const SKILL_CONTENT_TOOL_NAME = {
  load: "load-skill",
  readResource: "read-skill-resource",
} as const;

export type SkillContentToolName =
  (typeof SKILL_CONTENT_TOOL_NAME)[keyof typeof SKILL_CONTENT_TOOL_NAME];

export const SKILL_CONTENT_TOOL_NAMES = Object.values(SKILL_CONTENT_TOOL_NAME);
