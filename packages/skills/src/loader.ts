import { GENERATED_SKILLS } from "./skills.gen";

export type SkillMetadata = {
  description: string;
  name: string;
  version: string | null;
};

export type SkillResource = {
  path: string;
  kind: "knowledge" | "prompt";
};

export type StellaSkill = SkillMetadata & {
  body: string;
  resources: SkillResource[];
};

const RESOURCE_EXTENSIONS = [".md", ".prompt.md"] as const;
const skillsById: ReadonlyMap<string, GeneratedSkill> = new Map(
  GENERATED_SKILLS.map((skill) => [skill.id, skill]),
);

type Frontmatter = {
  description?: string | undefined;
  name?: string | undefined;
  version?: string | undefined;
};

type GeneratedSkill = (typeof GENERATED_SKILLS)[number];

export const listSkillMetadata = (): SkillMetadata[] =>
  GENERATED_SKILLS.map((skill) => readSkillMetadata(skill.id)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

export const loadSkill = (skillId: string): StellaSkill => {
  const skill = getSkill(skillId);
  const parsed = parseSkillFile(skill.source);

  return {
    ...parsed.metadata,
    body: parsed.body,
    resources: listSkillResources(skillId),
  };
};

export const listSkillResources = (skillId: string): SkillResource[] => {
  const skill = getSkill(skillId);
  return skill.resources.map(({ kind, path }) => ({ kind, path }));
};

export const readSkillResource = ({
  resourcePath,
  skillId,
}: {
  resourcePath: string;
  skillId: string;
}): string => {
  const normalizedPath = normalizeResourcePath(resourcePath);
  const skill = getSkill(skillId);
  if (!isAllowedResourcePath(normalizedPath)) {
    throw new Error("Skill resource path is not a whitelisted resource");
  }

  const resource = skill.resources.find(
    (candidate) => candidate.path === normalizedPath,
  );
  if (!resource) {
    throw new Error("Skill resource not found");
  }

  return resource.source;
};

const readSkillMetadata = (skillId: string): SkillMetadata =>
  parseSkillFile(getSkill(skillId).source).metadata;

const getSkill = (skillId: string) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) {
    throw new Error("Invalid skill id");
  }

  const skill = skillsById.get(skillId);
  if (!skill) {
    throw new Error(`Unknown skill: ${skillId}`);
  }

  return skill;
};

const parseSkillFile = (
  source: string,
): {
  body: string;
  metadata: SkillMetadata;
} => {
  if (!source.startsWith("---\n")) {
    throw new Error("Skill file missing frontmatter");
  }

  const end = source.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("Skill file missing frontmatter terminator");
  }

  const frontmatter = parseSimpleFrontmatter(source.slice(4, end));
  if (!frontmatter.name || !frontmatter.description) {
    throw new Error("Skill file frontmatter must include name and description");
  }

  return {
    metadata: {
      description: frontmatter.description,
      name: frontmatter.name,
      version: frontmatter.version ?? null,
    },
    body: source.slice(end + "\n---".length).trim(),
  };
};

const parseSimpleFrontmatter = (source: string): Frontmatter => {
  const frontmatter: Frontmatter = {};

  for (const line of source.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    if (!isFrontmatterKey(key)) {
      continue;
    }

    const value = stripYamlString(line.slice(separatorIndex + 1));
    frontmatter[key] = value;
  }

  return frontmatter;
};

const isFrontmatterKey = (key: string): key is keyof Frontmatter =>
  key === "name" || key === "description" || key === "version";

const stripYamlString = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.replace(/^["']|["']$/g, "");
};

const normalizeResourcePath = (resourcePath: string): string => {
  if (resourcePath.startsWith("/")) {
    throw new Error("Skill resource path must be relative");
  }

  const normalized = normalizePosixPath(resourcePath.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("Skill resource path escapes the skill directory");
  }

  return normalized;
};

const isAllowedResourcePath = (resourcePath: string): boolean => {
  const root = resourcePath.split("/").at(0);
  return (
    (root === "knowledge" || root === "prompts") &&
    hasAllowedResourceExtension(resourcePath)
  );
};

const hasAllowedResourceExtension = (resourcePath: string): boolean =>
  RESOURCE_EXTENSIONS.some((extension) => resourcePath.endsWith(extension));

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
