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
} from "../src/schema";

const MAX_ENTRY_BYTES = 10 * 1024 * 1024;

const packageRoot = path.join(import.meta.dirname, "..");
const entriesRoot = path.join(packageRoot, "entries");

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
    const slug = dirent.name;
    const folder = path.join(kindDir, slug);
    const manifestFile = path.join(folder, "manifest.json");

    if (!existsSync(manifestFile)) {
      errors.push(`${kind}/${slug}: missing manifest.json`);
      continue;
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    } catch (error) {
      errors.push(
        `${kind}/${slug}/manifest.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    const parsed = v.safeParse(catalogueEntrySchema, manifest);
    if (!parsed.success) {
      const issues = parsed.issues
        .map((issue) => `${v.getDotPath(issue) ?? "<root>"}: ${issue.message}`)
        .join("; ");
      errors.push(`${kind}/${slug}/manifest.json: ${issues}`);
      continue;
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
    if (parsed.output.kind === "skill") {
      const entryPath = normalizeCataloguePath(parsed.output.entryPath);
      if (entryPath === null) {
        errors.push(`${kind}/${slug}: entryPath escapes the entry folder`);
      } else {
        const bodyFile = path.join(folder, entryPath);
        if (!existsSync(bodyFile)) {
          errors.push(`${kind}/${slug}: entryPath file not found`);
        }
        const entryDirectory = path.dirname(entryPath);
        const resourceRoot =
          entryDirectory === "." ? folder : path.join(folder, entryDirectory);
        for (const resourcePath of parsed.output.resources) {
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
      }
    }

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

    const bytes = folderSize(folder);
    if (bytes > MAX_ENTRY_BYTES) {
      errors.push(
        `${kind}/${slug}: folder is ${formatBytes(bytes)}, exceeds ${formatBytes(MAX_ENTRY_BYTES)} cap`,
      );
    }
  }
}

const recommendedFile = path.join(entriesRoot, "recommended.json");
if (existsSync(recommendedFile)) {
  let recommended: unknown;
  try {
    recommended = JSON.parse(readFileSync(recommendedFile, "utf-8"));
  } catch (error) {
    errors.push(
      `recommended.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    recommended = null;
  }

  if (recommended !== null) {
    const parsed = v.safeParse(recommendedSchema, recommended);
    if (!parsed.success) {
      const issues = parsed.issues
        .map((issue) => `${v.getDotPath(issue) ?? "<root>"}: ${issue.message}`)
        .join("; ");
      errors.push(`recommended.json: ${issues}`);
    } else {
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
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`✗ ${error}`);
  }
  panic(`Catalogue validation failed (${errors.length} error(s))`);
}

console.log(
  `✓ Catalogue OK: ${Array.from(seenSlugs.values()).reduce((sum, set) => sum + set.size, 0)} entries`,
);

function pluralize(kind: (typeof CATALOGUE_KINDS)[number]): string {
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
