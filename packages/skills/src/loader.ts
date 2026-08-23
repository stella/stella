import { panic } from "better-result";

import { GENERATED_SKILLS } from "./skills.gen";

export type SkillMetadata = {
  compatibility?: string | null;
  description: string;
  license?: string | null;
  metadata?: Record<string, string>;
  name: string;
  version: string | null;
};

export type SkillResourceKind =
  | "asset"
  | "knowledge"
  | "other"
  | "prompt"
  | "reference"
  | "script"
  | "template";

export type SkillResource = {
  path: string;
  kind: SkillResourceKind;
};

export type StellaSkill = SkillMetadata & {
  body: string;
  resources: SkillResource[];
};

const RESOURCE_EXTENSIONS = [
  ".csv",
  ".json",
  ".md",
  ".mjs",
  ".prompt.md",
  ".py",
  ".sh",
  ".ts",
  ".tsv",
  ".txt",
  ".yaml",
  ".yml",
] as const;
const skillsById: ReadonlyMap<string, GeneratedSkill> = new Map(
  GENERATED_SKILLS.map((skill) => [skill.id, skill]),
);

type Frontmatter = {
  compatibility: string | undefined;
  description: string;
  license: string | undefined;
  metadata: Record<string, string> | undefined;
  name: string;
  version: string | undefined;
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
    panic("Skill resource path is not a whitelisted resource");
  }

  const resource = skill.resources.find(
    (candidate) => candidate.path === normalizedPath,
  );
  if (!resource) {
    panic("Skill resource not found");
  }

  return resource.source;
};

const readSkillMetadata = (skillId: string): SkillMetadata =>
  parseSkillFile(getSkill(skillId).source).metadata;

const getSkill = (skillId: string) => {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(skillId)) {
    panic("Invalid skill id");
  }

  const skill = skillsById.get(skillId);
  if (!skill) {
    panic(`Unknown skill: ${skillId}`);
  }

  return skill;
};

export const parseSkillFile = (
  source: string,
): {
  body: string;
  metadata: SkillMetadata;
} => {
  const normalizedSource = source
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");

  if (!normalizedSource.startsWith("---\n")) {
    panic("Skill file missing frontmatter");
  }

  let end = normalizedSource.indexOf("\n---\n", 4);
  if (end === -1 && normalizedSource.endsWith("\n---")) {
    end = normalizedSource.length - "\n---".length;
  }
  if (end === -1) {
    panic("Skill file missing frontmatter terminator");
  }

  const frontmatter = parseFrontmatter(normalizedSource.slice(4, end));

  return {
    metadata: {
      compatibility: frontmatter.compatibility ?? null,
      description: frontmatter.description,
      license: frontmatter.license ?? frontmatter.metadata?.["license"] ?? null,
      metadata: frontmatter.metadata ?? {},
      name: frontmatter.name,
      version: frontmatter.version ?? frontmatter.metadata?.["version"] ?? null,
    },
    body: normalizedSource.slice(end + "\n---".length).trim(),
  };
};

const parseFrontmatter = (source: string): Frontmatter => {
  const parsed = parseYaml(source);
  if (!isPlainRecord(parsed)) {
    panic("Skill file frontmatter must be a YAML mapping");
  }

  const name = readRequiredString(parsed, "name");
  const description = readRequiredString(parsed, "description");

  return {
    compatibility: readOptionalString(parsed, "compatibility"),
    description,
    license: readOptionalString(parsed, "license"),
    metadata: readMetadata(parsed["metadata"]),
    name,
    version: readOptionalString(parsed, "version"),
  };
};

const parseYaml = (source: string): unknown => {
  try {
    return Bun.YAML.parse(source);
  } catch {
    return panic("Skill file frontmatter must be valid YAML");
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const readRequiredString = (
  frontmatter: Record<string, unknown>,
  field: "description" | "name",
): string => {
  const value = readOptionalString(frontmatter, field);
  if (value === undefined || value.trim().length === 0) {
    panic("Skill file frontmatter must include name and description");
  }
  return value;
};

const readOptionalString = (
  frontmatter: Record<string, unknown>,
  field: Exclude<keyof Frontmatter, "metadata">,
): string | undefined => {
  const value = frontmatter[field];
  if (value === undefined || typeof value === "string") {
    return value;
  }
  return panic(`Skill file frontmatter ${field} must be a string`);
};

const readMetadata = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    panic("Skill file frontmatter metadata must be a string mapping");
  }

  const entries: [string, string][] = [];
  for (const [key, metadataValue] of Object.entries(value)) {
    if (typeof metadataValue !== "string") {
      panic("Skill file frontmatter metadata values must be strings");
    }
    entries.push([key, metadataValue]);
  }
  return Object.fromEntries(entries);
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
  getSkillResourceKind(resourcePath) !== null &&
  hasAllowedResourceExtension(resourcePath);

export const getSkillResourceKind = (
  resourcePath: string,
): SkillResourceKind | null => {
  const root = resourcePath.split("/").at(0);
  if (!root) {
    return null;
  }

  switch (root) {
    case "assets":
      return "asset";
    case "knowledge":
      return "knowledge";
    case "prompts":
      return "prompt";
    case "reference":
    case "references":
      return "reference";
    case "scripts":
      return "script";
    case "templates":
      return "template";
    default:
      return null;
  }
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
