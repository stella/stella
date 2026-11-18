import { Result } from "better-result";

import { createSha256 } from "@stll/sha256/bun";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  parseSkillFile,
  readDocumentedChatReads,
  readExcludedChatTools,
  readSkillDisplayName,
} from "./frontmatter";
import type { ParsedSkillMetadata, SkillMetadata } from "./frontmatter";
import {
  readSkillNetworkHosts,
  SKILL_NETWORK_HOSTS_MAX,
} from "./network-hosts";
import {
  readSkillRequiredTools,
  SKILL_REQUIRED_TOOLS_MAX,
} from "./required-tools";

export const SKILL_FILE_NAME = "SKILL.md";

export const SKILL_PACKAGE_LIMITS = {
  archiveFilesMax: 1000,
  archiveUncompressedMaxBytes: 50 * 1024 * 1024,
  bodyMaxChars: 80_000,
  compatibilityMaxChars: 500,
  descriptionMaxChars: 1024,
  githubDirectoriesMax: 100,
  licenseMaxChars: 256,
  metadataEntriesMax: 32,
  metadataKeyMaxChars: 64,
  metadataValueMaxChars: 512,
  /**
   * Largest resource file a skill stores. Reads window it (see
   * `resourceModelContextMaxChars`), so this bounds storage, not one read.
   */
  resourceMaxChars: 2_000_000,
  /**
   * Largest piece of one resource a model holds at once: the window a
   * resource read returns, and the whole file wherever a model reads or
   * writes it in one piece (an AI rewrite, a model-authored edit, draft
   * context, a shipped skill served whole over MCP `resources/read`).
   */
  resourceModelContextMaxChars: 100_000,
  resourcePathMaxChars: 512,
  resourcesPerSkillMax: 500,
  versionMaxChars: 64,
} as const;

export const SKILL_NAME_PATTERN = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Path grammar for a stored skill resource. The Agent Skills spec lets a skill
 * hold any files and folders beside SKILL.md, in any case, so this keeps only
 * what makes a path safe to store, serve and unpack: relative, `/`-separated,
 * no empty, `.` or `..` segment, no control, format or line-separator
 * characters, none of the characters Windows forbids in a file name
 * (a backslash or `< > : " | ? *`), and no segment that starts or ends with whitespace or
 * ends with a dot. `@stll/api-contract` holds the same pattern for browsers.
 */
export const SKILL_RESOURCE_PATH_PATTERN =
  /^(?!\.\.?(?:\/|$))[^\s/\\<>:"|?*\p{Cc}\p{Cf}](?:[^/\\<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*[^\s./\\<>:"|?*\p{Cc}\p{Cf}])?(?:\/(?!\.\.?(?:\/|$))[^\s/\\<>:"|?*\p{Cc}\p{Cf}](?:[^/\\<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*[^\s./\\<>:"|?*\p{Cc}\p{Cf}])?)*$/u;

/**
 * The folders the spec recommends. A package may use any folder; these are
 * the ones stella's own skills and AI-drafted files use, and a backticked
 * path into one of them is checked even before the folder exists.
 */
export const SKILL_RESOURCE_FOLDERS = new Set([
  "assets",
  "references",
  "scripts",
]);

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

/**
 * Extensions of files that are never text. A package file with one is left
 * out (and reported) by its path alone, so an import neither downloads nor
 * inflates it; any other file is kept when its bytes are UTF-8 text.
 */
const BINARY_RESOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  "7z",
  "a",
  "aac",
  "avi",
  "avif",
  "bin",
  "bmp",
  "bz2",
  "class",
  "dll",
  "doc",
  "docx",
  "dylib",
  "eot",
  "exe",
  "flac",
  "gif",
  "gz",
  "heic",
  "ico",
  "jar",
  "jpeg",
  "jpg",
  "key",
  "m4a",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "npy",
  "numbers",
  "o",
  "odp",
  "ods",
  "odt",
  "ogg",
  "otf",
  "pages",
  "parquet",
  "pdf",
  "pkl",
  "png",
  "ppt",
  "pptx",
  "psd",
  "pyc",
  "rar",
  "so",
  "sqlite",
  "tar",
  "tgz",
  "tif",
  "tiff",
  "ttf",
  "wasm",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "xz",
  "zip",
]);

const lastSegment = (path: string): string => path.split("/").at(-1) ?? "";

/** A file whose extension says it is binary; see `BINARY_RESOURCE_EXTENSIONS`. */
export const isKnownBinaryResourcePath = (path: string): boolean => {
  const name = lastSegment(path);
  const dot = name.lastIndexOf(".");
  return (
    dot > 0 && BINARY_RESOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
  );
};

/**
 * Files an operating system or archiver adds on its own (Finder metadata,
 * AppleDouble forks, Windows thumbnails). They are not part of any skill, so
 * a package drops them without reporting them.
 */
export const isOsMetadataPath = (path: string): boolean => {
  const name = lastSegment(path);
  return (
    path.startsWith("__MACOSX/") ||
    name === ".DS_Store" ||
    name.startsWith("._") ||
    name === "Thumbs.db" ||
    name === "desktop.ini"
  );
};

/**
 * Key two paths collide under: case-insensitive file systems (macOS, Windows)
 * and Unicode normalization would unpack them onto the same file.
 */
const resourcePathCollisionKey = (path: string): string =>
  normalizeUnicode(path, "NFC").toLowerCase();

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
  "stella-network-hosts": ({ metadata }: SkillMetadata) =>
    readSkillNetworkHosts(metadata) ?? [],
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

export type ValidatedSkillResource = SkillPackageFile;

/**
 * `extension`: the file's extension says it is binary. `binary`: its content
 * holds a NUL character, so it is not text.
 */
export type SkillPackageSkipReason = "binary" | "extension";

export type SkippedSkillPackageFile = {
  path: string;
  reason: SkillPackageSkipReason;
};

export type ValidatedSkillPackage = {
  body: string;
  metadata: ParsedSkillMetadata;
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

export const isSkillResourceFolder = (folder: string): boolean =>
  SKILL_RESOURCE_FOLDERS.has(folder);

/**
 * A backticked relative path with at least one folder, written in the plain
 * characters file references use. Prose in backticks (URLs, globs, anchors,
 * line suffixes, paths with spaces) does not match, so it is never mistaken
 * for a missing file.
 */
const skillResourceReferencePattern =
  /`([A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+)`/gu;

/** Backticked file paths in a SKILL.md body that may name package files. */
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

const hasFileExtension = (path: string): boolean =>
  /[^.]\.[A-Za-z0-9]+$/u.test(lastSegment(path));

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

type CollectedPackageResources = {
  paths: ReadonlySet<string>;
  resources: ValidatedSkillResource[];
  skipped: SkippedSkillPackageFile[];
};

/**
 * The package's files under the entry point's folder, as stored resources:
 * OS metadata dropped, binary files skipped, unsafe or colliding paths
 * reported into `diagnostics`.
 */
const collectPackageResources = ({
  diagnostics,
  entrypointPath,
  files,
}: {
  diagnostics: SkillPackageDiagnostic[];
  entrypointPath: string;
  files: readonly SkillPackageFile[];
}): CollectedPackageResources => {
  const prefix = entrypointPath.slice(0, -SKILL_FILE_NAME.length);
  const resources: ValidatedSkillResource[] = [];
  const skipped: SkippedSkillPackageFile[] = [];
  const paths = new Set<string>();
  // SKILL.md takes its key too: a `skill.md` beside it unpacks onto it.
  const collisionKeys = new Set([resourcePathCollisionKey(SKILL_FILE_NAME)]);
  for (const file of files) {
    if (!file.path.startsWith(prefix) || file.path === entrypointPath) {
      continue;
    }
    const path = normalizeUnicode(
      file.path.slice(prefix.length).replaceAll("\\", "/"),
      "NFC",
    );
    if (isOsMetadataPath(path)) {
      continue;
    }
    const skipReason = binarySkipReason({ content: file.content, path });
    if (skipReason !== null) {
      skipped.push({ path, reason: skipReason });
      continue;
    }
    if (
      path.length > SKILL_PACKAGE_LIMITS.resourcePathMaxChars ||
      !SKILL_RESOURCE_PATH_PATTERN.test(path)
    ) {
      diagnostics.push({ type: "resource_path_invalid", path });
      continue;
    }
    const collisionKey = resourcePathCollisionKey(path);
    if (collisionKeys.has(collisionKey)) {
      diagnostics.push({ type: "resource_duplicate", path });
      continue;
    }
    collisionKeys.add(collisionKey);
    paths.add(path);
    exceeds(
      diagnostics,
      path,
      file.content,
      SKILL_PACKAGE_LIMITS.resourceMaxChars,
    );
    resources.push({ ...file, path });
  }
  return { paths, resources, skipped };
};

const binarySkipReason = ({
  content,
  path,
}: {
  content: string;
  path: string;
}): SkillPackageSkipReason | null => {
  if (isKnownBinaryResourcePath(path)) {
    return "extension";
  }
  return content.includes("\0") ? "binary" : null;
};

/**
 * Backticked paths in SKILL.md that name no package file. Only paths into a
 * folder the package has (or a conventional one) are checked, so a path that
 * names some other project's file is not taken for a missing resource; a
 * binary file, or one the import skipped, is not missing.
 */
const missingReferenceDiagnostics = ({
  body,
  paths,
  skippedPaths,
}: {
  body: string;
  paths: ReadonlySet<string>;
  skippedPaths: readonly string[];
}): SkillPackageDiagnostic[] => {
  const referenceFolders = new Set(SKILL_RESOURCE_FOLDERS);
  for (const path of paths) {
    if (path.includes("/")) {
      referenceFolders.add(path.split("/").at(0) ?? "");
    }
  }
  const skippedReferencePaths = new Set(
    skippedPaths.map((path) => normalizeUnicode(path, "NFC")),
  );
  return readSkillResourceReferences(body)
    .map((reference) => normalizeUnicode(reference, "NFC"))
    .filter(
      (path) =>
        referenceFolders.has(path.split("/").at(0) ?? "") &&
        hasFileExtension(path) &&
        !isKnownBinaryResourcePath(path) &&
        !paths.has(path) &&
        !skippedReferencePaths.has(path),
    )
    .map((path): SkillPackageDiagnostic => ({
      type: "resource_reference_missing",
      path,
    }));
};

export const validateSkillPackage = ({
  files,
  skippedPaths = new Set(),
  tools,
}: {
  files: readonly SkillPackageFile[];
  /**
   * Package files the caller already left out (binary files it never
   * decoded). SKILL.md may still name them; that is not a missing reference.
   */
  skippedPaths?: ReadonlySet<string>;
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
  if (
    (readSkillNetworkHosts(metadata.metadata)?.length ?? 0) >
    SKILL_NETWORK_HOSTS_MAX
  ) {
    diagnostics.push({
      type: "limit_exceeded",
      field: "metadata.stella-network-hosts",
      limit: SKILL_NETWORK_HOSTS_MAX,
    });
  }
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

  const { paths, resources, skipped } = collectPackageResources({
    diagnostics,
    entrypointPath: entrypoint.path,
    files,
  });
  if (resources.length > SKILL_PACKAGE_LIMITS.resourcesPerSkillMax) {
    diagnostics.push({
      type: "limit_exceeded",
      field: "resources",
      limit: SKILL_PACKAGE_LIMITS.resourcesPerSkillMax,
    });
  }
  diagnostics.push(
    ...missingReferenceDiagnostics({
      body,
      paths,
      skippedPaths: [...skipped.map(({ path }) => path), ...skippedPaths],
    }),
  );
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

/** Hashes only SKILL.md bytes for the GitHub discovery integrity contract. */
export const hashSkillEntrypoint = (source: string): string => {
  const hasher = createSha256();
  const updateField = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    hasher.update(`${bytes.byteLength}:`);
    hasher.update(bytes);
  };
  updateField("stella-skill-package-v1");
  updateField(source);
  updateField("0");
  return hasher.digest("hex");
};

/** Hashes SKILL.md and resource paths and content for package identity. */
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
