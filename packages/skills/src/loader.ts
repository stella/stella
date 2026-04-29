import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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

const SKILLS_ROOT = path.join(import.meta.dirname, "..", "skills");
const SKILL_FILE_NAME = "SKILL.md";
const RESOURCE_ROOTS = ["knowledge", "prompts"] as const;
const RESOURCE_EXTENSIONS = [".md", ".prompt.md"] as const;
const skillResourcesCache = new Map<string, SkillResource[]>();

type Frontmatter = {
  description?: string | undefined;
  name?: string | undefined;
  version?: string | undefined;
};

export const listSkillMetadata = (): SkillMetadata[] =>
  listSkillIds()
    .map((skillId) => readSkillMetadata(skillId))
    .sort((a, b) => a.name.localeCompare(b.name));

export const loadSkill = (skillId: string): StellaSkill => {
  const skillPath = getSkillFilePath(skillId);
  const parsed = parseSkillFile(readFileSync(skillPath, "utf-8"));

  return {
    ...parsed.metadata,
    body: parsed.body,
    resources: listSkillResources(skillId),
  };
};

export const listSkillResources = (skillId: string): SkillResource[] => {
  const cachedResources = skillResourcesCache.get(skillId);
  if (cachedResources) {
    return cachedResources;
  }

  const skillDir = getSkillDir(skillId);
  const resources: SkillResource[] = [];

  for (const rootName of RESOURCE_ROOTS) {
    const rootDir = path.join(skillDir, rootName);
    if (!existsSync(rootDir)) {
      continue;
    }

    collectResourcePaths({
      baseDir: skillDir,
      currentDir: rootDir,
      kind: rootName === "knowledge" ? "knowledge" : "prompt",
      resources,
    });
  }

  const sortedResources = resources.sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  skillResourcesCache.set(skillId, sortedResources);
  return sortedResources;
};

export const readSkillResource = ({
  resourcePath,
  skillId,
}: {
  resourcePath: string;
  skillId: string;
}): string => {
  const normalizedPath = normalizeResourcePath(resourcePath);
  const skillDir = getSkillDir(skillId);
  const resolvedPath = path.resolve(skillDir, normalizedPath);
  const resolvedSkillDir = path.resolve(skillDir);

  if (!resolvedPath.startsWith(`${resolvedSkillDir}${path.sep}`)) {
    throw new Error("Skill resource path escapes the skill directory");
  }

  if (!isAllowedResourcePath(normalizedPath)) {
    throw new Error("Skill resource path is not a whitelisted resource");
  }

  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new Error("Skill resource not found");
  }

  return readFileSync(resolvedPath, "utf-8");
};

const listSkillIds = (): string[] =>
  readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillId) =>
      existsSync(path.join(SKILLS_ROOT, skillId, SKILL_FILE_NAME)),
    )
    .sort((a, b) => a.localeCompare(b));

const readSkillMetadata = (skillId: string): SkillMetadata =>
  parseSkillFile(readFileSync(getSkillFilePath(skillId), "utf-8")).metadata;

const getSkillDir = (skillId: string): string => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) {
    throw new Error("Invalid skill id");
  }

  const skillDir = path.join(SKILLS_ROOT, skillId);
  if (!existsSync(path.join(skillDir, SKILL_FILE_NAME))) {
    throw new Error(`Unknown skill: ${skillId}`);
  }

  return skillDir;
};

const getSkillFilePath = (skillId: string): string =>
  path.join(getSkillDir(skillId), SKILL_FILE_NAME);

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

const collectResourcePaths = ({
  baseDir,
  currentDir,
  kind,
  resources,
}: {
  baseDir: string;
  currentDir: string;
  kind: SkillResource["kind"];
  resources: SkillResource[];
}) => {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      collectResourcePaths({
        baseDir,
        currentDir: entryPath,
        kind,
        resources,
      });
      continue;
    }

    if (!entry.isFile() || !hasAllowedResourceExtension(entry.name)) {
      continue;
    }

    resources.push({
      kind,
      path: path.relative(baseDir, entryPath).split(path.sep).join("/"),
    });
  }
};

const normalizeResourcePath = (resourcePath: string): string => {
  if (path.isAbsolute(resourcePath)) {
    throw new Error("Skill resource path must be relative");
  }

  const normalized = path.posix.normalize(resourcePath.replaceAll("\\", "/"));
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
