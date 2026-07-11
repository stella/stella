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

  const end = normalizedSource.indexOf("\n---", 4);
  if (end === -1) {
    panic("Skill file missing frontmatter terminator");
  }

  const frontmatter = parseSimpleFrontmatter(normalizedSource.slice(4, end));
  if (!frontmatter.name || !frontmatter.description) {
    panic("Skill file frontmatter must include name and description");
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
  const lines = source.split("\n");
  let parsingMetadata = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line === undefined || line.trim().length === 0) {
      continue;
    }

    if (parsingMetadata && /^\s+/u.test(line)) {
      const metadataEntry = parseFrontmatterEntry(line.trim());
      if (metadataEntry) {
        frontmatter.metadata ??= {};
        frontmatter.metadata[metadataEntry.key] = metadataEntry.value;
      }
      continue;
    }

    parsingMetadata = false;
    const entry = splitFrontmatterEntry(line);
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

    const indicator = parseBlockScalarIndicator(entry.rawValue);
    if (indicator) {
      const block = readBlockScalar({ indicator, lines, startIndex: index });
      index = block.nextIndex;
      setFrontmatterValue({
        frontmatter,
        key: entry.key,
        value: block.value,
      });
      continue;
    }

    setFrontmatterValue({
      frontmatter,
      key: entry.key,
      value: stripYamlString(entry.rawValue),
    });
  }

  return frontmatter;
};

type BlockScalarIndicator = {
  chomp: "clip" | "strip";
  style: "folded" | "literal";
};

/** A bare block-scalar header (`>`, `>-`, `|`, `|-`, and the `+` keep
 *  forms), never inline text that merely starts with `>` or `|`. */
const parseBlockScalarIndicator = (
  rawValue: string,
): BlockScalarIndicator | null => {
  const match = /^(?<style>[|>])(?<chomp>[+-]?)$/u.exec(rawValue.trim());
  if (!match?.groups) {
    return null;
  }

  return {
    chomp: match.groups["chomp"] === "-" ? "strip" : "clip",
    style: match.groups["style"] === ">" ? "folded" : "literal",
  };
};

/**
 * Consume a top-level block scalar's indented body. Content lines are
 * those indented past column 0 (or blank); the first non-blank content
 * line sets the block indentation that is stripped from each line.
 * Folded joins lines with single spaces, literal with newlines; `strip`
 * chomping drops the trailing newline, `clip` keeps a single one.
 */
const readBlockScalar = ({
  indicator,
  lines,
  startIndex,
}: {
  indicator: BlockScalarIndicator;
  lines: readonly string[];
  startIndex: number;
}): { nextIndex: number; value: string } => {
  const contentLines: string[] = [];
  let index = startIndex;
  let blockIndent: number | null = null;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (line.trim().length === 0) {
      contentLines.push("");
      index += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      break;
    }
    blockIndent ??= indent;
    contentLines.push(stripLeadingSpaces(line, blockIndent));
    index += 1;
  }

  while (contentLines.at(-1) === "") {
    contentLines.pop();
  }

  const joined = contentLines.join(indicator.style === "folded" ? " " : "\n");
  const value = indicator.chomp === "strip" ? joined : `${joined}\n`;
  return { nextIndex: index, value };
};

const stripLeadingSpaces = (line: string, max: number): string => {
  let removed = 0;
  while (removed < max && (line[removed] === " " || line[removed] === "\t")) {
    removed += 1;
  }
  return line.slice(removed);
};

const parseFrontmatterEntry = (
  line: string,
): { key: string; value: string } | null => {
  const entry = splitFrontmatterEntry(line);
  if (!entry) {
    return null;
  }

  return { key: entry.key, value: stripYamlString(entry.rawValue) };
};

/**
 * Split `key: value` into the trimmed key and the raw (unstripped)
 * value. The raw value is kept so a block-scalar header (`>`, `|`, ...)
 * can be detected before quote-stripping would mangle it.
 */
const splitFrontmatterEntry = (
  line: string,
): { key: string; rawValue: string } | null => {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    key: line.slice(0, separatorIndex).trim(),
    rawValue: line.slice(separatorIndex + 1),
  };
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
  return trimmed.replace(/^["']|["']$/gu, "");
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
