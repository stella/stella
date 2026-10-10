import { panic, Result, TaggedError } from "better-result";

import { GENERATED_SKILLS } from "./skills.gen";

type SkillResourceKind =
  | "asset"
  | "knowledge"
  | "prompt"
  | "reference"
  | "script"
  | "template";

const RESOURCE_FOLDERS = new Map<string, SkillResourceKind>([
  ["assets", "asset"],
  ["knowledge", "knowledge"],
  ["prompts", "prompt"],
  ["reference", "reference"],
  ["references", "reference"],
  ["scripts", "script"],
  ["templates", "template"],
]);

const getSkillResourceKind = (path: string): SkillResourceKind | null =>
  RESOURCE_FOLDERS.get(path.split("/").at(0) ?? "") ?? null;

export type SkillMetadata = {
  compatibility?: string | null;
  description: string;
  license?: string | null;
  metadata?: Record<string, string>;
  name: string;
  version: string | null;
};

export type SkillResource = {
  path: string;
  kind: SkillResourceKind;
};

/** A skill shipped with stella: every organization has it, with no row. */
export type StellaSkill = SkillMetadata & {
  body: string;
  resources: SkillResource[];
};

/**
 * Frontmatter `metadata` key under which a skill names the chat tools a turn
 * must not offer while the skill is active. The Agent Skills spec reserves
 * `metadata` for host extensions; the value follows the `allowed-tools`
 * spelling: tool names separated by whitespace.
 */
export const CHAT_EXCLUDED_TOOLS_METADATA_KEY = "stella-chat-excluded-tools";
export const CHAT_DOCUMENTED_READS_METADATA_KEY =
  "stella-chat-documented-reads";
/**
 * Frontmatter `metadata` key holding the title a shipped skill is shown under.
 * `name` is the skill's slug, the identifier every tool and ref uses, so the
 * title lives beside it, as an installed skill's row keeps its name apart
 * from its slug.
 */
export const SKILL_DISPLAY_NAME_METADATA_KEY = "stella-display-name";

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

type Frontmatter = {
  compatibility: string | undefined;
  description: string;
  license: string | undefined;
  metadata: Record<string, string> | undefined;
  name: string;
  version: string | undefined;
};

type GeneratedSkill = (typeof GENERATED_SKILLS)[number];

const skillsById: ReadonlyMap<string, GeneratedSkill> = new Map(
  GENERATED_SKILLS.map((skill) => [skill.id, skill]),
);

/** The shipped skills' metadata, sorted by name. */
export const listSkillMetadata = (): SkillMetadata[] =>
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
  getSkill(skillId).resources.map(({ kind, path }) => ({ kind, path }));

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
  return resource
    ? { content: resource.source, kind: resource.kind, path: resource.path }
    : null;
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

/** A SKILL.md file whose frontmatter does not satisfy the skill format. */
export class SkillFileError extends TaggedError("SkillFileError")<{
  message: string;
}> {}

export type ParsedSkillFile = {
  body: string;
  metadata: SkillMetadata;
};

const skillFileError = (message: string) =>
  Result.err(new SkillFileError({ message }));

export const parseSkillFile = (
  source: string,
): Result<ParsedSkillFile, SkillFileError> =>
  Result.gen(function* () {
    const normalizedSource = source
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");

    if (!normalizedSource.startsWith("---\n")) {
      return skillFileError("Skill file missing frontmatter");
    }

    let end = normalizedSource.indexOf("\n---\n", 4);
    if (end === -1 && normalizedSource.endsWith("\n---")) {
      end = normalizedSource.length - "\n---".length;
    }
    if (end === -1) {
      return skillFileError("Skill file missing frontmatter terminator");
    }

    const frontmatter = yield* parseFrontmatter(normalizedSource.slice(4, end));

    return Result.ok({
      metadata: {
        compatibility: frontmatter.compatibility ?? null,
        description: frontmatter.description,
        license:
          frontmatter.license ?? frontmatter.metadata?.["license"] ?? null,
        metadata: frontmatter.metadata ?? {},
        name: frontmatter.name,
        version:
          frontmatter.version ?? frontmatter.metadata?.["version"] ?? null,
      },
      body: normalizedSource.slice(end + "\n---".length).trim(),
    });
  });

const parseFrontmatter = (
  source: string,
): Result<Frontmatter, SkillFileError> =>
  Result.gen(function* () {
    const parsed = yield* parseYaml(source);
    if (!isPlainRecord(parsed)) {
      return skillFileError("Skill file frontmatter must be a YAML mapping");
    }

    const name = yield* readRequiredString(parsed, "name");
    const description = yield* readRequiredString(parsed, "description");

    return Result.ok({
      compatibility: yield* readOptionalString(parsed, "compatibility"),
      description,
      license: yield* readOptionalString(parsed, "license"),
      metadata: yield* readMetadata(parsed["metadata"]),
      name,
      version: yield* readOptionalString(parsed, "version"),
    });
  });

const parseYaml = (source: string): Result<unknown, SkillFileError> =>
  Result.try({
    try: () => Bun.YAML.parse(source),
    catch: () =>
      new SkillFileError({
        message: "Skill file frontmatter must be valid YAML",
      }),
  });

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
): Result<string, SkillFileError> =>
  Result.gen(function* () {
    const value = yield* readOptionalString(frontmatter, field);
    if (value === undefined || value.trim().length === 0) {
      return skillFileError(
        "Skill file frontmatter must include name and description",
      );
    }
    return Result.ok(value);
  });

const readOptionalString = (
  frontmatter: Record<string, unknown>,
  field: Exclude<keyof Frontmatter, "metadata">,
): Result<string | undefined, SkillFileError> => {
  const value = frontmatter[field];
  if (value === undefined || typeof value === "string") {
    return Result.ok(value);
  }
  return skillFileError(`Skill file frontmatter ${field} must be a string`);
};

const readMetadata = (
  value: unknown,
): Result<Record<string, string> | undefined, SkillFileError> => {
  if (value === undefined) {
    return Result.ok(undefined);
  }
  if (!isPlainRecord(value)) {
    return skillFileError(
      "Skill file frontmatter metadata must be a string mapping",
    );
  }

  const entries: [string, string][] = [];
  for (const [key, metadataValue] of Object.entries(value)) {
    if (typeof metadataValue !== "string") {
      return skillFileError(
        "Skill file frontmatter metadata values must be strings",
      );
    }
    entries.push([key, metadataValue]);
  }
  return Result.ok(Object.fromEntries(entries));
};

/**
 * A whitespace-separated name list under one `metadata` key. Built-in skills
 * carry the mapping from `SKILL.md`; installed skills carry the same mapping
 * in their stored row, so both sources are read here. Empty when the key is
 * absent; deduplicated otherwise.
 */
const readMetadataNameList = (
  metadata: Readonly<Record<string, string>> | undefined,
  key: string,
): readonly string[] => {
  const value = metadata?.[key];
  if (value === undefined) {
    return [];
  }
  return [...new Set(value.split(/\s+/u).filter((name) => name.length > 0))];
};

/** The title a shipped skill is shown under; its `name` when it has none. */
export const readSkillDisplayName = ({
  metadata,
  name,
}: Pick<SkillMetadata, "metadata" | "name">): string => {
  const displayName = metadata?.[SKILL_DISPLAY_NAME_METADATA_KEY]?.trim();
  return displayName === undefined || displayName === "" ? name : displayName;
};

/** Chat tool names a skill excludes from the turns it is active in. */
export const readExcludedChatTools = (
  metadata: Readonly<Record<string, string>> | undefined,
): readonly string[] =>
  readMetadataNameList(metadata, CHAT_EXCLUDED_TOOLS_METADATA_KEY);

/**
 * Registry read tools a skill documents up front on the chat surface: their
 * full signatures join the code-mode prompt while the skill is active, so the
 * model writes the call without `discover_tools`. Values are registry names
 * (`list_documents`), not the sandbox's `external_` bindings. The chat side
 * narrows them to the reads it can document.
 */
export const readDocumentedChatReads = (
  metadata: Readonly<Record<string, string>> | undefined,
): readonly string[] =>
  readMetadataNameList(metadata, CHAT_DOCUMENTED_READS_METADATA_KEY);

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
