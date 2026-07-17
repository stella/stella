/**
 * Catalogue PR-time validator. Beyond schema parsing (handled by the
 * loader at import), this enforces:
 *   - per-entry folder size cap (10 MB; prevents PDF dumps in PRs)
 *   - per-file icon size cap (512 KiB; icons are base64-inlined into the
 *     web bundle for every entry, so this applies even to github entries
 *     that skip the folder cap)
 *   - slug uniqueness across the whole catalogue
 *   - recommended.json references exist
 *   - manifest folder matches `entries/<kind>/<slug>/`
 * Runs in CI; failure blocks merge.
 */
import { panic } from "better-result";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  catalogueEntrySchema,
  CATALOGUE_KINDS,
  recommendedSchema,
  type CatalogueEntry,
  type CatalogueKind,
} from "../src/schema";
import {
  getInspectedDirectoryEntries,
  getInspectedFilePath,
  inspectCatalogueFilesystem,
  type InspectedCatalogueFilesystem,
} from "./catalogue-filesystem";

const MAX_ENTRY_BYTES = 10 * 1024 * 1024;

/**
 * Per-file cap for the inlined icons. generate-manifest.ts base64-encodes
 * icon.png/icon.svg straight into the web bundle, so an oversized icon
 * bloats the client payload regardless of the folder cap the github
 * source is otherwise exempt from.
 */
const MAX_ICON_FILE_BYTES = 512 * 1024;

/** Icon files that generate-manifest.ts inlines, in the order it prefers. */
const ICON_FILE_NAMES = ["icon.png", "icon.svg"] as const;

/** Files a github-sourced skill folder may contain; content is upstream. */
const GITHUB_SKILL_ALLOWED_FILES: ReadonlySet<string> = new Set([
  "manifest.json",
  ...ICON_FILE_NAMES,
]);

const isIgnoredOsMetadataFile = (name: string): boolean =>
  name === ".DS_Store" || name.startsWith("._");

type ValidationResult = {
  errors: string[];
  entryCount: number;
};

type EntryLocation = {
  filesystem: InspectedCatalogueFilesystem;
  kind: CatalogueKind;
  slug: string;
  folder: string;
};

/**
 * Runs every PR-time check against `entriesRoot` and returns the
 * collected errors plus the entry count. Exported for tests; the CLI
 * main below drives it against the package's real `entries/` folder.
 */
export const validateCatalogue = (entriesRoot: string): ValidationResult => {
  const filesystem = inspectCatalogueFilesystem(entriesRoot);
  const errors: string[] = [];

  const seenSlugs = new Map<string, Set<string>>();
  for (const kind of CATALOGUE_KINDS) {
    seenSlugs.set(kind, new Set<string>());
  }
  const seenCatalogueSlugs = new Map<string, string>();

  for (const kind of CATALOGUE_KINDS) {
    const kindDir = path.join(entriesRoot, pluralize(kind));
    const kindEntries = getInspectedDirectoryEntries(filesystem, kindDir);
    if (kindEntries === null) {
      continue;
    }

    for (const entry of kindEntries) {
      if (entry.type !== "directory") {
        continue;
      }
      const location: EntryLocation = {
        filesystem,
        folder: path.join(kindDir, entry.name),
        kind,
        slug: entry.name,
      };
      validateEntryFolder(location, errors);
      trackSlugUniqueness(location, seenSlugs, seenCatalogueSlugs, errors);
    }
  }

  validateRecommendedFile(filesystem, entriesRoot, seenSlugs, errors);

  const entryCount = Array.from(seenSlugs.values()).reduce(
    (sum, set) => sum + set.size,
    0,
  );
  return { entryCount, errors };
};

const validateEntryFolder = (
  location: EntryLocation,
  errors: string[],
): void => {
  const entry = readEntryManifest(location, errors);
  if (entry === null) {
    return;
  }

  // Icons are inlined into the web bundle for every entry, so cap them
  // regardless of source (github entries skip the folder cap below).
  validateIconSizes(location, errors);

  const isGithubSkill = entry.kind === "skill" && entry.source === "github";
  if (isGithubSkill) {
    validateGithubSkillFolder(location, errors);
  }
  if (entry.kind === "skill" && entry.source === "in-tree") {
    validateInTreeSkillContent(location, entry, errors);
  }

  // github skills keep content upstream, so the in-tree size cap does
  // not apply to them.
  if (!isGithubSkill) {
    const bytes = folderSize(location.filesystem, location.folder);
    if (bytes > MAX_ENTRY_BYTES) {
      errors.push(
        `${location.kind}/${location.slug}: folder is ${formatBytes(bytes)}, exceeds ${formatBytes(MAX_ENTRY_BYTES)} cap`,
      );
    }
  }
};

/**
 * Caps each inlined icon file. Enforced for every entry — github-sourced
 * included — since generate-manifest.ts base64-inlines the icon into the
 * client bundle even when the folder itself skips the size cap.
 */
const validateIconSizes = (location: EntryLocation, errors: string[]): void => {
  for (const iconName of ICON_FILE_NAMES) {
    const iconFile = path.join(location.folder, iconName);
    const inspectedIconFile = getInspectedFilePath(
      location.filesystem,
      iconFile,
    );
    if (inspectedIconFile === null) {
      continue;
    }
    const bytes = statSync(inspectedIconFile).size;
    if (bytes > MAX_ICON_FILE_BYTES) {
      errors.push(
        `${location.kind}/${location.slug}: ${iconName} is ${formatBytes(bytes)}, exceeds ${formatBytes(MAX_ICON_FILE_BYTES)} icon cap`,
      );
    }
  }
};

/**
 * Parses and schema-validates the folder's manifest.json. Folder/kind
 * and folder/slug mismatches are reported but still return the parsed
 * entry so the remaining checks run.
 */
const readEntryManifest = (
  location: EntryLocation,
  errors: string[],
): CatalogueEntry | null => {
  const { kind, slug, folder } = location;
  const manifestFile = path.join(folder, "manifest.json");
  const inspectedManifestFile = getInspectedFilePath(
    location.filesystem,
    manifestFile,
  );

  if (inspectedManifestFile === null) {
    errors.push(`${kind}/${slug}: missing manifest.json`);
    return null;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(inspectedManifestFile, "utf-8"));
  } catch (error) {
    errors.push(
      `${kind}/${slug}/manifest.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }

  const parsed = v.safeParse(catalogueEntrySchema, manifest);
  if (!parsed.success) {
    errors.push(
      `${kind}/${slug}/manifest.json: ${formatIssues(parsed.issues)}`,
    );
    return null;
  }

  if (parsed.output.kind !== kind) {
    errors.push(
      `${kind}/${slug}: manifest kind "${parsed.output.kind}" does not match folder kind "${kind}"`,
    );
  }
  if (parsed.output.slug !== slug) {
    errors.push(
      `${kind}/${slug}: manifest slug "${parsed.output.slug}" does not match folder name`,
    );
  }
  return parsed.output;
};

/**
 * Content lives upstream at the pinned SHA; the folder must hold only
 * the manifest and an optional icon. repo/rev formats are already
 * validated by the schema.
 */
const validateGithubSkillFolder = (
  location: EntryLocation,
  errors: string[],
): void => {
  const entries = getInspectedDirectoryEntries(
    location.filesystem,
    location.folder,
  );
  if (entries === null) {
    panic(`${location.kind}/${location.slug}: entry folder disappeared`);
  }
  for (const child of entries) {
    if (isIgnoredOsMetadataFile(child.name)) {
      continue;
    }
    if (!GITHUB_SKILL_ALLOWED_FILES.has(child.name)) {
      errors.push(
        `${location.kind}/${location.slug}: github-sourced skill must not include local content (found "${child.name}"); content lives upstream`,
      );
    }
  }
};

const validateInTreeSkillContent = (
  location: EntryLocation,
  entry: Extract<CatalogueEntry, { kind: "skill"; source: "in-tree" }>,
  errors: string[],
): void => {
  const { kind, slug, folder } = location;
  const entryPath = normalizeCataloguePath(entry.entryPath);
  if (entryPath === null) {
    errors.push(`${kind}/${slug}: entryPath escapes the entry folder`);
    return;
  }

  const bodyFile = path.join(folder, entryPath);
  if (getInspectedFilePath(location.filesystem, bodyFile) === null) {
    errors.push(`${kind}/${slug}: entryPath file not found`);
  }

  const entryDirectory = path.dirname(entryPath);
  const resourceRoot =
    entryDirectory === "." ? folder : path.join(folder, entryDirectory);
  for (const resourcePath of entry.resources) {
    const normalizedResourcePath = normalizeCataloguePath(resourcePath);
    if (normalizedResourcePath === null) {
      errors.push(
        `${kind}/${slug}: resource path escapes the entry folder: ${resourcePath}`,
      );
      continue;
    }
    const resourceFile = path.join(resourceRoot, normalizedResourcePath);
    if (getInspectedFilePath(location.filesystem, resourceFile) === null) {
      errors.push(
        `${kind}/${slug}: resource file not found: ${normalizedResourcePath}`,
      );
    }
  }
};

const trackSlugUniqueness = (
  location: EntryLocation,
  seenSlugs: Map<string, Set<string>>,
  seenCatalogueSlugs: Map<string, string>,
  errors: string[],
): void => {
  const { kind, slug } = location;
  const seen = seenSlugs.get(kind);
  if (seen?.has(slug)) {
    errors.push(`${kind}/${slug}: duplicate slug within kind`);
  } else {
    seen?.add(slug);
  }
  const existingSlugKind = seenCatalogueSlugs.get(slug);
  if (existingSlugKind) {
    errors.push(
      `${kind}/${slug}: duplicate slug already used by ${existingSlugKind}/${slug}`,
    );
  } else {
    seenCatalogueSlugs.set(slug, kind);
  }
};

const validateRecommendedFile = (
  filesystem: InspectedCatalogueFilesystem,
  entriesRoot: string,
  seenSlugs: Map<string, Set<string>>,
  errors: string[],
): void => {
  const recommendedFile = path.join(entriesRoot, "recommended.json");
  const inspectedRecommendedFile = getInspectedFilePath(
    filesystem,
    recommendedFile,
  );
  if (inspectedRecommendedFile === null) {
    return;
  }

  let recommended: unknown;
  try {
    recommended = JSON.parse(readFileSync(inspectedRecommendedFile, "utf-8"));
  } catch (error) {
    errors.push(
      `recommended.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }

  const parsed = v.safeParse(recommendedSchema, recommended);
  if (!parsed.success) {
    errors.push(`recommended.json: ${formatIssues(parsed.issues)}`);
    return;
  }

  const allKnownSlugs = new Set<string>();
  for (const slugs of seenSlugs.values()) {
    for (const slug of slugs) {
      allKnownSlugs.add(slug);
    }
  }
  for (const [jurisdiction, slugs] of Object.entries(parsed.output)) {
    for (const slug of slugs) {
      if (!allKnownSlugs.has(slug)) {
        errors.push(
          `recommended.json[${jurisdiction}]: unknown slug "${slug}"`,
        );
      }
    }
  }
};

const formatIssues = (issues: readonly v.BaseIssue<unknown>[]): string =>
  issues
    .map((issue) => `${v.getDotPath(issue) ?? "<root>"}: ${issue.message}`)
    .join("; ");

if (import.meta.main) {
  const packageRoot = path.join(import.meta.dirname, "..");
  const { entryCount, errors } = validateCatalogue(
    path.join(packageRoot, "entries"),
  );

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`✗ ${error}`);
    }
    panic(`Catalogue validation failed (${errors.length} error(s))`);
  }

  console.log(`✓ Catalogue OK: ${entryCount} entries`);
}

function pluralize(kind: CatalogueKind): string {
  if (kind === "native-tool") {
    return "native-tools";
  }
  return `${kind}s`;
}

function folderSize(
  filesystem: InspectedCatalogueFilesystem,
  folder: string,
): number {
  let total = 0;
  const entries = getInspectedDirectoryEntries(filesystem, folder);
  if (entries === null) {
    panic(`Catalogue folder disappeared during validation: ${folder}`);
  }
  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);
    if (entry.type === "directory") {
      total += folderSize(filesystem, fullPath);
      continue;
    }
    const inspectedFile = getInspectedFilePath(filesystem, fullPath);
    if (inspectedFile === null) {
      panic(`Catalogue file disappeared during validation: ${fullPath}`);
    }
    total += statSync(inspectedFile).size;
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeCataloguePath(rawPath: string): string | null {
  if (rawPath.startsWith("/")) {
    return null;
  }

  const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }

  return normalized;
}
