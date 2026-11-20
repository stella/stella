import { Result } from "better-result";

import { sha256Hex } from "@stll/sha256/node";

import {
  isReservedSkillPackagePath,
  SKILL_FILE_NAME,
  SKILL_NAME_PATTERN,
  SKILL_PACKAGE_LIMITS,
  SKILL_PACKAGE_RESERVED_FOLDER,
  SKILL_PACKAGE_RESOURCE_PATH_PATTERN,
} from "./format";

/**
 * The portable skill package: one folder named after the skill's slug,
 * holding SKILL.md, every file of the skill at its own path, and
 * `.stella/manifest.json`. A host that reads standard skill folders uses the
 * folder as it is and ignores `.stella/`; stella reads the manifest back to
 * restore what SKILL.md does not carry (the display name and the command) and
 * to check every file arrived unchanged.
 *
 * Layout, `formatVersion` 1:
 *
 *     <slug>/SKILL.md
 *     <slug>/<path of each file>
 *     <slug>/.stella/manifest.json
 *
 * `.zip` and `.skill` are the same archive under two file names.
 */
export const SKILL_PACKAGE_FORMAT_VERSION = 1;

export const SKILL_PACKAGE_MANIFEST_PATH = `${SKILL_PACKAGE_RESERVED_FOLDER}/manifest.json`;

export const SKILL_PACKAGE_FORMATS = ["zip", "skill"] as const;
export type SkillPackageFormat = (typeof SKILL_PACKAGE_FORMATS)[number];

/** File name extension and media type a package is delivered under. */
export const SKILL_PACKAGE_FILE_TYPES = {
  skill: { extension: "skill", mediaType: "application/zip" },
  zip: { extension: "zip", mediaType: "application/zip" },
} as const satisfies Record<
  SkillPackageFormat,
  { extension: string; mediaType: string }
>;

/** Bytes a manifest may take: every file's entry, generously bounded. */
const MANIFEST_MAX_BYTES = 1024 * 1024;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const DISPLAY_NAME_MAX_CHARS = 64;

const isDisplayName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= DISPLAY_NAME_MAX_CHARS;
const COMMAND_MAX_CHARS = 50;

export type SkillPackageManifestFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type SkillPackageManifest = {
  formatVersion: typeof SKILL_PACKAGE_FORMAT_VERSION;
  skill: {
    /** Slash command, without the slash; null when the skill has none. */
    command: string | null;
    /** The name people see, which SKILL.md's `name` cannot spell. */
    displayName: string;
    slug: string;
  };
  /** Every file of the package but the manifest, SKILL.md included. */
  files: readonly SkillPackageManifestFile[];
};

/** One file of a package, at its path inside the archive. */
export type SkillArchiveEntry = {
  bytes: Uint8Array;
  path: string;
};

export type SkillPackageSource = {
  command: string | null;
  displayName: string;
  /** Files beside SKILL.md, at their paths relative to the skill folder. */
  resources: readonly SkillArchiveEntry[];
  skillMd: string;
  slug: string;
};

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

/**
 * The package for one skill, as archive entries in a stable order. The
 * caller has already read the skill under the reader's access; nothing here
 * decides what may be exported.
 */
export const buildSkillPackage = (
  source: SkillPackageSource,
): SkillArchiveEntry[] => {
  const files: SkillArchiveEntry[] = [
    { bytes: UTF8_ENCODER.encode(source.skillMd), path: SKILL_FILE_NAME },
    ...source.resources
      .filter(({ path }) => !isReservedSkillPackagePath(path))
      .toSorted((left, right) => compareCodeUnits(left.path, right.path)),
  ];
  const manifest: SkillPackageManifest = {
    formatVersion: SKILL_PACKAGE_FORMAT_VERSION,
    skill: {
      command: source.command,
      // A name the manifest cannot hold falls back to the slug, so every
      // package built here reads back.
      displayName: isDisplayName(source.displayName)
        ? source.displayName
        : source.slug,
      slug: source.slug,
    },
    files: files.map(({ bytes, path }) => ({
      path,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
    })),
  };
  return [
    ...files,
    {
      bytes: UTF8_ENCODER.encode(`${JSON.stringify(manifest, null, 2)}\n`),
      path: SKILL_PACKAGE_MANIFEST_PATH,
    },
  ].map(({ bytes, path }) => ({ bytes, path: `${source.slug}/${path}` }));
};

/** The download name of a package: the skill's slug and the format. */
export const skillPackageFileName = (
  slug: string,
  format: SkillPackageFormat,
): string => `${slug}.${SKILL_PACKAGE_FILE_TYPES[format].extension}`;

/**
 * Whether bytes are a zip archive, read from the bytes alone: a local file
 * header, or the end record of an empty archive. A package is recognized by
 * its content whatever its file is called (`.zip`, `.skill`, or nothing).
 */
export const isZipArchiveBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06));

export type SkillPackageManifestRefusal =
  | { type: "manifest_invalid"; reason: string }
  | { type: "format_version_unsupported"; formatVersion: number }
  | { type: "file_missing"; path: string }
  | { type: "file_changed"; path: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (reason: string) =>
  Result.err<never, SkillPackageManifestRefusal>({
    type: "manifest_invalid",
    reason,
  });

const readManifestFile = (
  value: unknown,
): SkillPackageManifestFile | string => {
  if (!isRecord(value)) {
    return "a file entry is not an object";
  }
  const { path, sha256, sizeBytes } = value;
  if (
    typeof path !== "string" ||
    path.length > SKILL_PACKAGE_LIMITS.resourcePathMaxChars ||
    !SKILL_PACKAGE_RESOURCE_PATH_PATTERN.test(path)
  ) {
    return "a file path is invalid";
  }
  if (typeof sha256 !== "string" || !SHA256_HEX_PATTERN.test(sha256)) {
    return `the hash of ${path} is invalid`;
  }
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0
  ) {
    return `the size of ${path} is invalid`;
  }
  return { path, sha256, sizeBytes };
};

const readOptionalCommand = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= COMMAND_MAX_CHARS
    ? value
    : undefined;
};

/**
 * Read `.stella/manifest.json`. A manifest from a newer format is refused
 * rather than read as this one: its fields may mean something else.
 */
export const parseSkillPackageManifest = (
  bytes: Uint8Array,
): Result<SkillPackageManifest, SkillPackageManifestRefusal> => {
  if (bytes.byteLength > MANIFEST_MAX_BYTES) {
    return invalid("the manifest is too large");
  }
  const parsed = Result.try((): unknown =>
    JSON.parse(UTF8_DECODER.decode(bytes)),
  );
  if (parsed.isErr()) {
    return invalid("the manifest is not JSON");
  }
  const manifest = parsed.value;
  if (!isRecord(manifest)) {
    return invalid("the manifest is not an object");
  }
  const { files, formatVersion, skill } = manifest;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion)) {
    return invalid("formatVersion is missing");
  }
  if (formatVersion !== SKILL_PACKAGE_FORMAT_VERSION) {
    return Result.err({ type: "format_version_unsupported", formatVersion });
  }
  if (!isRecord(skill)) {
    return invalid("skill is missing");
  }
  const { command, displayName, slug } = skill;
  if (typeof slug !== "string" || !SKILL_NAME_PATTERN.test(slug)) {
    return invalid("skill.slug is invalid");
  }
  if (!isDisplayName(displayName)) {
    return invalid("skill.displayName is invalid");
  }
  const storedCommand = readOptionalCommand(command);
  if (storedCommand === undefined) {
    return invalid("skill.command is invalid");
  }
  if (
    !Array.isArray(files) ||
    files.length > SKILL_PACKAGE_LIMITS.archiveFilesMax
  ) {
    return invalid("files is invalid");
  }
  const entries: SkillPackageManifestFile[] = [];
  const seen = new Set<string>();
  for (const value of files) {
    const entry = readManifestFile(value);
    if (typeof entry === "string") {
      return invalid(entry);
    }
    if (seen.has(entry.path)) {
      return invalid(`${entry.path} is listed twice`);
    }
    seen.add(entry.path);
    entries.push(entry);
  }
  if (!seen.has(SKILL_FILE_NAME)) {
    return invalid("SKILL.md is not listed");
  }
  return Result.ok({
    formatVersion,
    skill: { command: storedCommand, displayName, slug },
    files: entries,
  });
};

/**
 * Check the package's files against its manifest: every listed file is
 * there with the bytes it was exported with. `digests` maps each file the
 * reader read (relative to the skill folder) to its SHA-256; `unread` holds
 * files the reader left out without reading their bytes, which are not
 * checked. A file the manifest does not list is allowed, so another tool may
 * add one.
 */
export const verifySkillPackageFiles = ({
  digests,
  manifest,
  unread,
}: {
  digests: ReadonlyMap<string, string>;
  manifest: SkillPackageManifest;
  unread: ReadonlySet<string>;
}): Result<void, SkillPackageManifestRefusal> => {
  for (const { path, sha256 } of manifest.files) {
    if (unread.has(path)) {
      continue;
    }
    const digest = digests.get(path);
    if (digest === undefined) {
      return Result.err({ type: "file_missing", path });
    }
    if (digest !== sha256) {
      return Result.err({ type: "file_changed", path });
    }
  }
  return Result.ok(undefined);
};

/** A package read back: the skill folder's files and its manifest. */
export type ReadSkillPackage = {
  /** Files beside SKILL.md, relative to the skill folder, sorted by path. */
  resources: SkillArchiveEntry[];
  manifest: SkillPackageManifest | null;
  skillMd: string;
};

export type SkillPackageReadRefusal =
  | SkillPackageManifestRefusal
  | { type: "entrypoint_missing" }
  | { type: "entrypoint_not_text" };

/**
 * Read a package from its archive entries: the shallowest SKILL.md is the
 * skill folder, its manifest (when present) is checked against every file,
 * and nothing in the reserved folder becomes a file of the skill. Files
 * outside the skill folder are not part of it.
 */
export const readSkillPackage = (
  entries: readonly SkillArchiveEntry[],
): Result<ReadSkillPackage, SkillPackageReadRefusal> => {
  const entrypoint = entries
    .filter(
      ({ path }) =>
        path === SKILL_FILE_NAME || path.endsWith(`/${SKILL_FILE_NAME}`),
    )
    .toSorted((left, right) => left.path.length - right.path.length)
    .at(0);
  if (entrypoint === undefined) {
    return Result.err({ type: "entrypoint_missing" });
  }
  const root = entrypoint.path.slice(0, -SKILL_FILE_NAME.length);
  const skillMd = Result.try(() => UTF8_DECODER.decode(entrypoint.bytes));
  if (skillMd.isErr()) {
    return Result.err({ type: "entrypoint_not_text" });
  }
  const digests = new Map([[SKILL_FILE_NAME, sha256Hex(entrypoint.bytes)]]);
  const resources: SkillArchiveEntry[] = [];
  let manifestBytes: Uint8Array | null = null;
  for (const { bytes, path } of entries) {
    if (!path.startsWith(root) || path === entrypoint.path) {
      continue;
    }
    const relative = path.slice(root.length);
    if (relative === SKILL_PACKAGE_MANIFEST_PATH) {
      manifestBytes = bytes;
      continue;
    }
    if (isReservedSkillPackagePath(relative)) {
      continue;
    }
    digests.set(relative, sha256Hex(bytes));
    resources.push({ bytes, path: relative });
  }
  let manifest: SkillPackageManifest | null = null;
  if (manifestBytes !== null) {
    const parsed = parseSkillPackageManifest(manifestBytes);
    if (parsed.isErr()) {
      return Result.err(parsed.error);
    }
    const verified = verifySkillPackageFiles({
      digests,
      manifest: parsed.value,
      unread: new Set(),
    });
    if (verified.isErr()) {
      return Result.err(verified.error);
    }
    manifest = parsed.value;
  }
  return Result.ok({
    manifest,
    resources: resources.toSorted((left, right) =>
      compareCodeUnits(left.path, right.path),
    ),
    skillMd: skillMd.value,
  });
};
