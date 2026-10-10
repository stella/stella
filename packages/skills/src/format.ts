import { Result } from "better-result";

import { createSha256 } from "@stll/sha256/bun";

import {
  parseSkillFile,
  readDocumentedChatReads,
  readExcludedChatTools,
  readSkillDisplayName,
} from "./loader";
import type { SkillMetadata } from "./loader";
import {
  readSkillRequiredTools,
  SKILL_REQUIRED_TOOLS_MAX,
} from "./required-tools";

export const SKILL_FILE_NAME = "SKILL.md";

export const SKILL_PACKAGE_LIMITS = {
  archiveFilesMax: 100,
  archiveUncompressedMaxBytes: 6 * 1024 * 1024,
  bodyMaxChars: 80_000,
  compatibilityMaxChars: 500,
  descriptionMaxChars: 1024,
  githubDirectoriesMax: 100,
  licenseMaxChars: 256,
  metadataEntriesMax: 32,
  metadataKeyMaxChars: 64,
  metadataValueMaxChars: 512,
  resourceMaxChars: 100_000,
  resourcePathMaxChars: 512,
  resourcesPerSkillMax: 50,
  versionMaxChars: 64,
} as const;

export const SKILL_NAME_PATTERN = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const SKILL_RESOURCE_PATH_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;

export const SKILL_RESOURCE_FOLDER_KINDS = {
  assets: "asset",
  knowledge: "knowledge",
  prompts: "prompt",
  reference: "reference",
  references: "reference",
  scripts: "script",
  templates: "template",
} as const;

export const SKILL_RESOURCE_KINDS = [
  "asset",
  "knowledge",
  "prompt",
  "reference",
  "script",
  "template",
] as const satisfies readonly (typeof SKILL_RESOURCE_FOLDER_KINDS)[keyof typeof SKILL_RESOURCE_FOLDER_KINDS][];

export type SkillResourceKind =
  (typeof SKILL_RESOURCE_FOLDER_KINDS)[keyof typeof SKILL_RESOURCE_FOLDER_KINDS];

export const SKILL_RESOURCE_EXTENSIONS = [
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

export const SKILL_METADATA_REGISTRY = {
  "stella-chat-documented-reads": ({ metadata }: SkillMetadata) =>
    readDocumentedChatReads(metadata),
  "stella-chat-excluded-tools": ({ metadata }: SkillMetadata) =>
    readExcludedChatTools(metadata),
  "stella-display-name": (metadata: SkillMetadata) => {
    const value = readSkillDisplayName(metadata);
    return metadata.metadata?.["stella-display-name"]?.trim() === ""
      ? []
      : [value];
  },
  "stella-required-tools": ({ metadata }: SkillMetadata) =>
    readSkillRequiredTools(metadata),
} as const satisfies Record<
  string,
  (metadata: SkillMetadata) => readonly string[]
>;

const isSkillMetadataKey = (
  key: string,
): key is keyof typeof SKILL_METADATA_REGISTRY =>
  Object.hasOwn(SKILL_METADATA_REGISTRY, key);

export type SkillPackageFile = {
  content: string;
  path: string;
  sizeBytes?: number;
};

export type ValidatedSkillResource = SkillPackageFile & {
  kind: SkillResourceKind;
};

export type SkillPackageSkipReason = "extension" | "folder";

export type SkippedSkillPackageFile = {
  path: string;
  reason: SkillPackageSkipReason;
};

export type ValidatedSkillPackage = {
  body: string;
  metadata: SkillMetadata;
  resources: readonly ValidatedSkillResource[];
  skipped: readonly SkippedSkillPackageFile[];
  source: string;
};

export type SkillPackageDiagnostic =
  | { type: "entrypoint_missing" }
  | { type: "frontmatter_invalid"; message: string }
  | { type: "limit_exceeded"; field: string; limit: number }
  | { type: "bidi_control"; field: string }
  | { type: "name_invalid"; name: string }
  | { type: "metadata_key_unknown"; key: string }
  | { type: "metadata_value_invalid"; key: string }
  | { type: "required_tool_unknown"; tool: string }
  | { type: "resource_path_invalid"; path: string }
  | { type: "resource_duplicate"; path: string }
  | { type: "resource_reference_missing"; path: string };

const bidiPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const isSkillResourceFolder = (
  folder: string,
): folder is keyof typeof SKILL_RESOURCE_FOLDER_KINDS =>
  Object.hasOwn(SKILL_RESOURCE_FOLDER_KINDS, folder);

export const getSkillResourceKind = (
  path: string,
): SkillResourceKind | null => {
  const folder = path.split("/").at(0);
  if (folder === undefined || !isSkillResourceFolder(folder)) {
    return null;
  }
  return SKILL_RESOURCE_FOLDER_KINDS[folder];
};

export const isAllowedFirstPartySkillPackageSkip = ({
  path,
}: SkippedSkillPackageFile): boolean => !path.includes("/");

const BACKTICK = "`";
const resourceFolderPattern = Object.keys(SKILL_RESOURCE_FOLDER_KINDS).join(
  "|",
);
const skillResourceReferencePattern = new RegExp(
  `${BACKTICK}((?:${resourceFolderPattern})/[^${BACKTICK}\\s]+)${BACKTICK}`,
  "gu",
);

export const readSkillResourceReferences = (body: string): string[] => {
  const paths: string[] = [];
  for (const match of body.matchAll(skillResourceReferencePattern)) {
    const path = match[1];
    if (path !== undefined && SKILL_RESOURCE_PATH_PATTERN.test(path)) {
      paths.push(path);
    }
  }
  return paths;
};

const exceeds = (
  diagnostics: SkillPackageDiagnostic[],
  field: string,
  value: string | null | undefined,
  limit: number,
) => {
  if (value !== null && value !== undefined && value.length > limit) {
    diagnostics.push({ type: "limit_exceeded", field, limit });
  }
};

const archiveDiagnostics = (
  files: readonly SkillPackageFile[],
): SkillPackageDiagnostic[] => {
  const diagnostics: SkillPackageDiagnostic[] = [];
  if (files.length > SKILL_PACKAGE_LIMITS.archiveFilesMax) {
    diagnostics.push({
      type: "limit_exceeded",
      field: "archive files",
      limit: SKILL_PACKAGE_LIMITS.archiveFilesMax,
    });
  }
  const encoder = new TextEncoder();
  const archiveBytes = files.reduce(
    (total, file) =>
      total + (file.sizeBytes ?? encoder.encode(file.content).byteLength),
    0,
  );
  if (archiveBytes > SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes) {
    diagnostics.push({
      type: "limit_exceeded",
      field: "archive bytes",
      limit: SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes,
    });
  }
  return diagnostics;
};

const compareResourcePaths = (
  left: SkillPackageFile,
  right: SkillPackageFile,
): number => {
  if (left.path < right.path) {
    return -1;
  }
  return left.path > right.path ? 1 : 0;
};

const validateMetadataEntries = (
  metadata: SkillMetadata,
  diagnostics: SkillPackageDiagnostic[],
) => {
  const entries = Object.entries(metadata.metadata ?? {});
  if (entries.length > SKILL_PACKAGE_LIMITS.metadataEntriesMax) {
    diagnostics.push({
      type: "limit_exceeded",
      field: "metadata",
      limit: SKILL_PACKAGE_LIMITS.metadataEntriesMax,
    });
  }
  for (const [key, value] of entries) {
    exceeds(
      diagnostics,
      "metadata key",
      key,
      SKILL_PACKAGE_LIMITS.metadataKeyMaxChars,
    );
    exceeds(
      diagnostics,
      `metadata.${key}`,
      value,
      SKILL_PACKAGE_LIMITS.metadataValueMaxChars,
    );
    if (key.startsWith("stella-") && !isSkillMetadataKey(key)) {
      diagnostics.push({ type: "metadata_key_unknown", key });
      continue;
    }
    if (
      isSkillMetadataKey(key) &&
      SKILL_METADATA_REGISTRY[key](metadata).length === 0
    ) {
      diagnostics.push({ type: "metadata_value_invalid", key });
    }
  }
};

export const validateSkillPackage = ({
  files,
  tools,
}: {
  files: readonly SkillPackageFile[];
  tools: { type: "check"; known: ReadonlySet<string> } | { type: "deferred" };
}): Result<ValidatedSkillPackage, SkillPackageDiagnostic[]> => {
  const diagnostics = archiveDiagnostics(files);
  const entrypoints = files
    .filter(
      ({ path }) =>
        path === SKILL_FILE_NAME || path.endsWith(`/${SKILL_FILE_NAME}`),
    )
    .toSorted((left, right) => left.path.length - right.path.length);
  const entrypoint = entrypoints.at(0);
  if (entrypoint === undefined) {
    diagnostics.push({ type: "entrypoint_missing" });
    return Result.err(diagnostics);
  }

  const parsed = parseSkillFile(entrypoint.content);
  if (parsed.isErr()) {
    diagnostics.push({
      type: "frontmatter_invalid",
      message: parsed.error.message,
    });
    return Result.err(diagnostics);
  }
  const { body, metadata } = parsed.value;
  exceeds(diagnostics, "body", body, SKILL_PACKAGE_LIMITS.bodyMaxChars);
  exceeds(
    diagnostics,
    "description",
    metadata.description,
    SKILL_PACKAGE_LIMITS.descriptionMaxChars,
  );
  exceeds(
    diagnostics,
    "compatibility",
    metadata.compatibility,
    SKILL_PACKAGE_LIMITS.compatibilityMaxChars,
  );
  exceeds(
    diagnostics,
    "license",
    metadata.license,
    SKILL_PACKAGE_LIMITS.licenseMaxChars,
  );
  exceeds(
    diagnostics,
    "version",
    metadata.version,
    SKILL_PACKAGE_LIMITS.versionMaxChars,
  );
  if (!SKILL_NAME_PATTERN.test(metadata.name)) {
    diagnostics.push({ type: "name_invalid", name: metadata.name });
  }
  for (const [field, value] of Object.entries({
    compatibility: metadata.compatibility,
    description: metadata.description,
    license: metadata.license,
    name: metadata.name,
    version: metadata.version,
  })) {
    if (value && bidiPattern.test(value)) {
      diagnostics.push({ type: "bidi_control", field });
    }
  }

  validateMetadataEntries(metadata, diagnostics);
  const required = readSkillRequiredTools(metadata.metadata);
  if (required.length > SKILL_REQUIRED_TOOLS_MAX) {
    diagnostics.push({
      type: "limit_exceeded",
      field: "metadata.stella-required-tools",
      limit: SKILL_REQUIRED_TOOLS_MAX,
    });
  }
  if (tools.type === "check") {
    for (const tool of required) {
      if (!tools.known.has(tool)) {
        diagnostics.push({ type: "required_tool_unknown", tool });
      }
    }
  }

  const prefix = entrypoint.path.slice(0, -SKILL_FILE_NAME.length);
  const resources: ValidatedSkillResource[] = [];
  const skipped: SkippedSkillPackageFile[] = [];
  const paths = new Set<string>();
  for (const file of files) {
    if (!file.path.startsWith(prefix) || file.path === entrypoint.path) {
      continue;
    }
    const path = file.path.slice(prefix.length).replaceAll("\\", "/");
    const kind = getSkillResourceKind(path);
    if (kind === null) {
      skipped.push({ path, reason: "folder" });
      continue;
    }
    if (
      !SKILL_RESOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))
    ) {
      skipped.push({ path, reason: "extension" });
      continue;
    }
    if (
      path.length > SKILL_PACKAGE_LIMITS.resourcePathMaxChars ||
      !SKILL_RESOURCE_PATH_PATTERN.test(path)
    ) {
      diagnostics.push({ type: "resource_path_invalid", path });
      continue;
    }
    if (paths.has(path)) {
      diagnostics.push({ type: "resource_duplicate", path });
      continue;
    }
    paths.add(path);
    exceeds(
      diagnostics,
      path,
      file.content,
      SKILL_PACKAGE_LIMITS.resourceMaxChars,
    );
    resources.push({ ...file, kind, path });
  }
  if (resources.length > SKILL_PACKAGE_LIMITS.resourcesPerSkillMax) {
    diagnostics.push({
      type: "limit_exceeded",
      field: "resources",
      limit: SKILL_PACKAGE_LIMITS.resourcesPerSkillMax,
    });
  }
  for (const path of readSkillResourceReferences(body)) {
    if (!paths.has(path)) {
      diagnostics.push({ type: "resource_reference_missing", path });
    }
  }
  if (diagnostics.length > 0) {
    return Result.err(diagnostics);
  }
  return Result.ok({
    body,
    metadata,
    // File-system and archive traversal order is not part of the package.
    resources: resources.toSorted(compareResourcePaths),
    skipped,
    source: entrypoint.content,
  });
};

export const hashSkillPackage = ({
  resources,
  source,
}: {
  resources: readonly Pick<SkillPackageFile, "content" | "path">[];
  source: string;
}): string => {
  const hasher = createSha256();
  hasher.update(source);
  for (const resource of resources.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hasher.update("\0");
    hasher.update(resource.path);
    hasher.update("\0");
    hasher.update(resource.content);
  }
  return hasher.digest("hex");
};
