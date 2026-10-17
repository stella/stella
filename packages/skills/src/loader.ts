import { panic, Result } from "better-result";

import { isSkillResourceFolder, SKILL_RESOURCE_EXTENSIONS } from "./format";
import { parseSkillFile } from "./frontmatter";
import type { ParsedSkillFile, ParsedSkillMetadata } from "./frontmatter";
import { GENERATED_SKILLS } from "./skills.gen";

export type { BuiltInSkillId } from "./skills.gen";

export type SkillResource = {
  path: string;
};

/** A skill shipped with stella: every organization has it, with no row. */
export type StellaSkill = ParsedSkillMetadata & {
  body: string;
  resources: SkillResource[];
};

type GeneratedSkill = (typeof GENERATED_SKILLS)[number];

const skillsById: ReadonlyMap<string, GeneratedSkill> = new Map(
  GENERATED_SKILLS.map((skill) => [skill.id, skill]),
);

/** The shipped skills' metadata, sorted by name. */
export const listSkillMetadata = (): ParsedSkillMetadata[] =>
  GENERATED_SKILLS.map((skill) => parseShippedSkill(skill).metadata).toSorted(
    (a, b) => a.name.localeCompare(b.name),
  );

/** One shipped skill; `skillId` must name one (see `listSkillMetadata`). */
export const loadSkill = (skillId: string): StellaSkill => {
  const skill = getSkill(skillId);
  const parsed = parseShippedSkill(skill);

  return {
    ...parsed.metadata,
    body: parsed.body,
    resources: listSkillResources(skillId),
  };
};

export const listSkillResources = (skillId: string): SkillResource[] =>
  getSkill(skillId).resources.map(({ path }) => ({ path }));

/**
 * One resource file of a shipped skill by its exact path, as a stored skill's
 * resources are read; `null` when the skill ships no file at that path.
 */
export const readSkillResource = ({
  resourcePath,
  skillId,
}: {
  resourcePath: string;
  skillId: string;
}): (SkillResource & { content: string }) | null => {
  const resource = getSkill(skillId).resources.find(
    ({ path }) => path === resourcePath,
  );
  return resource ? { content: resource.source, path: resource.path } : null;
};

const getSkill = (skillId: string): GeneratedSkill => {
  const skill = skillsById.get(skillId);
  if (!skill) {
    panic(`Unknown built-in skill: ${skillId}`);
  }
  return skill;
};

// A shipped SKILL.md that does not parse is a build defect, not a runtime
// failure: the package tests parse every shipped skill.
const parseShippedSkill = (skill: GeneratedSkill): ParsedSkillFile => {
  const parsed = parseSkillFile(skill.source);
  if (Result.isError(parsed)) {
    panic(`Built-in skill ${skill.id}: ${parsed.error.message}`);
  }
  return parsed.value;
};

export const normalizeResourcePath = (resourcePath: string): string => {
  if (resourcePath.startsWith("/")) {
    panic("Skill resource path must be relative");
  }

  const normalized = normalizePosixPath(resourcePath.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    panic("Skill resource path escapes the skill directory");
  }

  return normalized;
};

export const isAllowedResourcePath = (resourcePath: string): boolean =>
  isSkillResourceFolder(resourcePath.split("/").at(0) ?? "") &&
  hasAllowedResourceExtension(resourcePath);

const hasAllowedResourceExtension = (resourcePath: string): boolean =>
  SKILL_RESOURCE_EXTENSIONS.some((extension) =>
    resourcePath.endsWith(extension),
  );

const normalizePosixPath = (resourcePath: string): string => {
  const segments: string[] = [];

  for (const segment of resourcePath.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        return "..";
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  if (segments.length === 0) {
    return ".";
  }

  return segments.join("/");
};
