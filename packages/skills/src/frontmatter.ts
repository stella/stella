import { Result, TaggedError } from "better-result";

/**
 * Whether the model may pick a skill by itself (`auto`) or the skill runs only
 * when the user invokes it (`manual`).
 */
export const SKILL_INVOCATIONS = ["auto", "manual"] as const;
export type SkillInvocation = (typeof SKILL_INVOCATIONS)[number];

export type SkillMetadata = {
  compatibility?: string | null;
  description: string;
  /** Read from the file; a stored row carries it in its own column. */
  invocation?: SkillInvocation;
  license?: string | null;
  metadata?: Record<string, string>;
  name: string;
  version: string | null;
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
/**
 * Frontmatter `metadata` key holding a skill's invocation (`auto` or
 * `manual`). The top-level `disable-model-invocation: true` that other Agent
 * Skills hosts write means `manual` too, so an imported package keeps it.
 * The parsed value moves to `SkillMetadata.invocation`; the key does not stay
 * in `metadata`.
 */
export const SKILL_INVOCATION_METADATA_KEY = "stella-invocation";
const DISABLE_MODEL_INVOCATION_KEY = "disable-model-invocation";

type Frontmatter = {
  compatibility: string | undefined;
  description: string;
  invocation: SkillInvocation;
  license: string | undefined;
  metadata: Record<string, string> | undefined;
  name: string;
  version: string | undefined;
};

/** A SKILL.md file whose frontmatter does not satisfy the skill format. */
export class SkillFileError extends TaggedError("SkillFileError")<{
  message: string;
}> {}

/** Metadata read from a file, which always settles the invocation. */
export type ParsedSkillMetadata = SkillMetadata & {
  invocation: SkillInvocation;
};

export type ParsedSkillFile = {
  body: string;
  metadata: ParsedSkillMetadata;
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
        invocation: frontmatter.invocation,
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
    const metadata = yield* readMetadata(parsed["metadata"]);
    const invocation = yield* readInvocation({
      disableModelInvocation: parsed[DISABLE_MODEL_INVOCATION_KEY],
      metadataValue: metadata?.[SKILL_INVOCATION_METADATA_KEY],
    });

    return Result.ok({
      compatibility: yield* readOptionalString(parsed, "compatibility"),
      description,
      invocation,
      license: yield* readOptionalString(parsed, "license"),
      metadata: withoutInvocationKey(metadata),
      name,
      version: yield* readOptionalString(parsed, "version"),
    });
  });

/**
 * YAML 1.1 spells booleans `yes`/`no`/`on`/`off` too, and Agent Skills files
 * written for other hosts use them; the 1.2 parser leaves those as strings.
 */
const YAML_BOOLEAN_SPELLINGS: ReadonlyMap<string, boolean> = new Map([
  ["false", false],
  ["n", false],
  ["no", false],
  ["off", false],
  ["on", true],
  ["true", true],
  ["y", true],
  ["yes", true],
]);

const readLenientBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return YAML_BOOLEAN_SPELLINGS.get(value.trim().toLowerCase());
};

const isSkillInvocation = (value: string): value is SkillInvocation =>
  SKILL_INVOCATIONS.some((invocation) => invocation === value);

/**
 * The skill's invocation from `metadata.stella-invocation` and the top-level
 * `disable-model-invocation`. An unknown value or a contradiction between the
 * two is refused rather than read as `auto`, so a skill meant to run only on
 * request never becomes one the model picks by itself.
 */
const readInvocation = ({
  disableModelInvocation,
  metadataValue,
}: {
  disableModelInvocation: unknown;
  metadataValue: string | undefined;
}): Result<SkillInvocation, SkillFileError> => {
  let fromMetadata: SkillInvocation | undefined;
  if (metadataValue !== undefined) {
    const normalized = metadataValue.trim().toLowerCase();
    if (!isSkillInvocation(normalized)) {
      return skillFileError(
        `Skill file metadata ${SKILL_INVOCATION_METADATA_KEY} must be one of: ${SKILL_INVOCATIONS.join(", ")}`,
      );
    }
    fromMetadata = normalized;
  }

  let fromFlag: SkillInvocation | undefined;
  if (disableModelInvocation !== undefined && disableModelInvocation !== null) {
    const disabled = readLenientBoolean(disableModelInvocation);
    if (disabled === undefined) {
      return skillFileError(
        `Skill file frontmatter ${DISABLE_MODEL_INVOCATION_KEY} must be a boolean`,
      );
    }
    fromFlag = disabled ? "manual" : "auto";
  }

  if (
    fromMetadata !== undefined &&
    fromFlag !== undefined &&
    fromMetadata !== fromFlag
  ) {
    return skillFileError(
      `Skill file frontmatter ${DISABLE_MODEL_INVOCATION_KEY} contradicts metadata ${SKILL_INVOCATION_METADATA_KEY}`,
    );
  }
  return Result.ok(fromMetadata ?? fromFlag ?? "auto");
};

const withoutInvocationKey = (
  metadata: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (metadata === undefined || !(SKILL_INVOCATION_METADATA_KEY in metadata)) {
    return metadata;
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => key !== SKILL_INVOCATION_METADATA_KEY,
    ),
  );
};

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
