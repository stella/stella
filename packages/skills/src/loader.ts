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
  compatibility?: string | undefined;
  description?: string | undefined;
  license?: string | undefined;
  metadata?: Record<string, string> | undefined;
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
    throw new Error("Skill file missing frontmatter");
  }

  const end = normalizedSource.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("Skill file missing frontmatter terminator");
  }

  const frontmatter = parseSimpleFrontmatter(normalizedSource.slice(4, end));
  if (!frontmatter.name || !frontmatter.description) {
    throw new Error("Skill file frontmatter must include name and description");
  }

  return {
    metadata: {
      compatibility: frontmatter.compatibility ?? null,
      description: frontmatter.description,
      license: frontmatter.license ?? null,
      metadata: frontmatter.metadata ?? {},
      name: frontmatter.name,
      version: frontmatter.version ?? frontmatter.metadata?.["version"] ?? null,
    },
    body: normalizedSource.slice(end + "\n---".length).trim(),
  };
};

const parseSimpleFrontmatter = (source: string): Frontmatter => {
  const frontmatter: Frontmatter = {};
  let parsingMetadata = false;

  for (const line of source.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    if (parsingMetadata && /^\s+/.test(line)) {
      const metadataEntry = parseFrontmatterEntry(line.trim());
      if (metadataEntry) {
        frontmatter.metadata ??= {};
        frontmatter.metadata[metadataEntry.key] = metadataEntry.value;
      }
      continue;
    }

    parsingMetadata = false;
    const entry = parseFrontmatterEntry(line);
    if (!entry) {
      continue;
    }
    if (entry.key === "metadata") {
      frontmatter.metadata ??= {};
      parsingMetadata = true;
      continue;
    }
    if (!isFrontmatterKey(entry.key)) {
      continue;
    }

    setFrontmatterValue({
      frontmatter,
      key: entry.key,
      value: entry.value,
    });
  }

  return frontmatter;
};

const parseFrontmatterEntry = (
  line: string,
): { key: string; value: string } | null => {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const key = line.slice(0, separatorIndex).trim();
  const value = stripYamlString(line.slice(separatorIndex + 1));
  return { key, value };
};

const isFrontmatterKey = (key: string): key is keyof Frontmatter =>
  key === "compatibility" ||
  key === "description" ||
  key === "license" ||
  key === "name" ||
  key === "version";

const setFrontmatterValue = ({
  frontmatter,
  key,
  value,
}: {
  frontmatter: Frontmatter;
  key: keyof Frontmatter;
  value: string;
}) => {
  switch (key) {
    case "compatibility":
      frontmatter.compatibility = value;
      return;
    case "description":
      frontmatter.description = value;
      return;
    case "license":
      frontmatter.license = value;
      return;
    case "name":
      frontmatter.name = value;
      return;
    case "version":
      frontmatter.version = value;
      return;
    case "metadata":
      return;
    default:
      return;
  }
};

const stripYamlString = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.replace(/^["']|["']$/g, "");
};

export const normalizeResourcePath = (resourcePath: string): string => {
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
