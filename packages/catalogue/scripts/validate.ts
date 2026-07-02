/**
 * Catalogue PR-time validator. Beyond schema parsing (handled by the
 * loader at import), this enforces:
 *   - per-entry folder size cap (10 MB; prevents PDF dumps in PRs)
 *   - slug uniqueness across the whole catalogue
 *   - recommended.json references exist
 *   - manifest folder matches `entries/<kind>/<slug>/`
 * Runs in CI; failure blocks merge.
 */
import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  catalogueEntrySchema,
  CATALOGUE_KINDS,
  recommendedSchema,
  type CatalogueEntry,
  type CatalogueKind,
} from "../src/schema";

const MAX_ENTRY_BYTES = 10 * 1024 * 1024;

/** Files a github-sourced skill folder may contain; content is upstream. */
const GITHUB_SKILL_ALLOWED_FILES: ReadonlySet<string> = new Set([
  "manifest.json",
  "icon.png",
  "icon.svg",
]);

type ValidationResult = {
  errors: string[];
  entryCount: number;
};

type EntryLocation = {
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
  const errors: string[] = [];

  const seenSlugs = new Map<string, Set<string>>();
  for (const kind of CATALOGUE_KINDS) {
    seenSlugs.set(kind, new Set<string>());
  }
  const seenCatalogueSlugs = new Map<string, string>();

  for (const kind of CATALOGUE_KINDS) {
    const kindDir = path.join(entriesRoot, pluralize(kind));
    if (!existsSync(kindDir)) {
      continue;
    }

    for (const dirent of readdirSync(kindDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const location: EntryLocation = {
        folder: path.join(kindDir, dirent.name),
        kind,
        slug: dirent.name,
      };
      validateEntryFolder(location, errors);
      trackSlugUniqueness(location, seenSlugs, seenCatalogueSlugs, errors);
    }
  }

  validateRecommendedFile(entriesRoot, seenSlugs, errors);

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
    const bytes = folderSize(location.folder);
    if (bytes > MAX_ENTRY_BYTES) {
      errors.push(
        `${location.kind}/${location.slug}: folder is ${formatBytes(bytes)}, exceeds ${formatBytes(MAX_ENTRY_BYTES)} cap`,
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

  if (!existsSync(manifestFile)) {
    errors.push(`${kind}/${slug}: missing manifest.json`);
    return null;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
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
  for (const child of readdirSync(location.folder, { withFileTypes: true })) {
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
  if (!existsSync(bodyFile)) {
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
    if (!existsSync(resourceFile)) {
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
  entriesRoot: string,
  seenSlugs: Map<string, Set<string>>,
  errors: string[],
): void => {
  const recommendedFile = path.join(entriesRoot, "recommended.json");
  if (!existsSync(recommendedFile)) {
    return;
  }

  let recommended: unknown;
  try {
    recommended = JSON.parse(readFileSync(recommendedFile, "utf-8"));
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

function folderSize(folder: string): number {
  let total = 0;
  for (const dirent of readdirSync(folder, { withFileTypes: true })) {
    const fullPath = path.join(folder, dirent.name);
    if (dirent.isDirectory()) {
      total += folderSize(fullPath);
    } else {
      total += statSync(fullPath).size;
    }
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
