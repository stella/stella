/**
 * Pure client-side helpers for the "add a skill" contribute flow. No
 * React, no network, no node-only code: the only `@stll/catalogue`
 * import is the client-safe Valibot manifest schema, so this stays
 * trivially testable and safe for the SSR route module.
 */
import * as v from "valibot";

import {
  GITHUB_REPO_PATTERN,
  GITHUB_REV_PATTERN,
  MAX_SLUG_LENGTH,
  skillEntrySchema,
} from "@stll/catalogue";
import type {
  CatalogueCost,
  CatalogueLicense,
  CatalogueSetup,
} from "@stll/catalogue";

import { STELLA_REPO_URL } from "@/routes/tools/-components/tool-detail.logic";

/** Where the skill's content lives relative to this repository. */
export type SkillSource = "github" | "in-tree";

/**
 * Flat contribute-form state. Kept as plain strings/arrays so the React
 * component can bind inputs directly and this module can build + validate
 * a manifest from a snapshot without touching the DOM.
 */
export type ContributeFormState = {
  name: string;
  slug: string;
  description: string;
  author: string;
  authorUrl: string;
  license: CatalogueLicense;
  cost: CatalogueCost;
  setup: CatalogueSetup;
  jurisdictions: readonly string[];
  tags: readonly string[];
  source: SkillSource;
  repo: string;
  directory: string;
  rev: string;
};

/** In-tree skills expose a `SKILL.md` sibling to the manifest. */
const SKILL_ENTRY_PATH = "SKILL.md";
/** Relative `$schema` ref used by the committed entry manifests. */
const MANIFEST_SCHEMA_REF = "../../../schema.json";

/**
 * Derive a kebab-case slug from a display name: fold diacritics, lower
 * case, collapse every run of non-alphanumerics to a single hyphen, trim
 * hyphens, and cap length to the schema's 64-char limit.
 */
export const deriveSlug = (name: string): string => {
  const kebab = name
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return kebab.slice(0, MAX_SLUG_LENGTH).replaceAll(/-+$/gu, "");
};

/** A full 40-character lowercase hex commit SHA (abbreviated refs fail). */
export const isFullCommitSha = (value: string): boolean =>
  GITHUB_REV_PATTERN.test(value);

/**
 * Normalize a repo reference to the bare `owner/name` identifier. Accepts
 * `owner/name`, an `https://github.com/owner/name` URL, `github.com/…`,
 * and a trailing `.git`; returns `null` when it is not a valid GitHub
 * `owner/name`.
 *
 * Order matters: strip protocol/host and every trailing slash first, then
 * peel the `.git` suffix last. Stripping `.git` first would leave it
 * intact for inputs like `…/repo.git/` (the trailing slash blocks the
 * `\.git$` anchor), yielding a `repo.git` identifier that 404s upstream.
 */
export const normalizeGithubRepo = (input: string): string | null => {
  const withoutHost = input
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//u, "")
    .replace(/^github\.com\//u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  const groups = GITHUB_REPO_PATTERN.exec(withoutHost)?.groups;
  return groups ? `${groups["owner"]}/${groups["name"]}` : null;
};

/** Unauthenticated, CORS-enabled latest-commit lookup for a repo. */
export const githubCommitsApiUrl = (repo: string): string =>
  `https://api.github.com/repos/${repo}/commits?per_page=1`;

const commitsResponseSchema = v.array(v.object({ sha: v.string() }));

/**
 * Extract the newest commit SHA from a `GET /commits?per_page=1`
 * response, or `null` when the payload is unexpected or the SHA is not a
 * full 40-char hash. Parsed with Valibot so no `as` cast is needed.
 */
export const firstCommitShaFromResponse = (payload: unknown): string | null => {
  const parsed = v.safeParse(commitsResponseSchema, payload);
  if (!parsed.success) {
    return null;
  }
  const sha = parsed.output.at(0)?.sha;
  return sha && isFullCommitSha(sha) ? sha : null;
};

/**
 * GitHub new-file editor deep link, pre-filled with the manifest at the
 * catalogue's conventional path. GitHub auto-forks for users without
 * write access and shapes the change into a pull request.
 */
export const githubNewFileUrl = ({
  slug,
  manifestJson,
}: {
  slug: string;
  manifestJson: string;
}): string =>
  `${STELLA_REPO_URL}/new/main?filename=packages/catalogue/entries/skills/${slug}/manifest.json&value=${encodeURIComponent(manifestJson)}`;

/**
 * Build a skill manifest object from form state. Optional fields are
 * omitted when blank so the preview stays clean and `v.url()` checks do
 * not trip on empty strings. Keys are inserted in the same order the
 * committed manifests use.
 */
export const buildSkillManifest = (
  form: ContributeFormState,
): Record<string, unknown> => {
  const manifest: Record<string, unknown> = {
    $schema: MANIFEST_SCHEMA_REF,
    kind: "skill",
    source: form.source,
    slug: form.slug,
    displayName: form.name,
    description: form.description,
    author: form.author,
  };
  const authorUrl = form.authorUrl.trim();
  if (authorUrl) {
    manifest["authorUrl"] = authorUrl;
  }
  manifest["license"] = form.license;
  manifest["cost"] = form.cost;
  manifest["setup"] = form.setup;
  if (form.tags.length > 0) {
    manifest["tags"] = [...form.tags];
  }
  if (form.jurisdictions.length > 0) {
    manifest["jurisdictions"] = [...form.jurisdictions];
  }
  if (form.source === "github") {
    manifest["repo"] = normalizeGithubRepo(form.repo) ?? form.repo.trim();
    manifest["rev"] = form.rev.trim();
    const directory = form.directory.trim();
    if (directory) {
      manifest["directory"] = directory;
    }
  } else {
    manifest["entryPath"] = SKILL_ENTRY_PATH;
  }
  return manifest;
};

export type ManifestEvaluation = {
  json: string;
  valid: boolean;
  /** Dot-paths of fields that failed schema validation (for hinting). */
  invalidFields: readonly string[];
};

/**
 * Build, serialize, and validate the manifest for the current form. The
 * pretty JSON is always returned (for the live preview); `valid` gates
 * the "open a pull request" CTA, and `invalidFields` drives inline hints.
 */
export const evaluateManifest = (
  form: ContributeFormState,
): ManifestEvaluation => {
  const manifest = buildSkillManifest(form);
  const json = JSON.stringify(manifest, null, 2);
  const result = v.safeParse(skillEntrySchema, manifest);
  if (result.success) {
    return { json, valid: true, invalidFields: [] };
  }
  const invalidFields = result.issues.map(
    (issue) => v.getDotPath(issue) ?? "<root>",
  );
  return { json, valid: false, invalidFields };
};
