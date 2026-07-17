import { panic, Result } from "better-result";

import {
  findCatalogueEntry,
  githubRawContentBaseUrl,
  isGithubSkillEntry,
} from "@stll/catalogue";
import type { LoadedGithubSkillEntry } from "@stll/catalogue";
import type { LoadedCatalogueSkillInstallPayload } from "@stll/catalogue/install-payloads";
import { findCatalogueSkillInstallPayload } from "@stll/catalogue/install-payloads";
import { catalogueLicensesMatch } from "@stll/catalogue/schema";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { fetchGithubCatalogueSkillPackage } from "@/api/lib/skill-package";
import type {
  GithubSkillPath,
  ParsedSkillPackage,
} from "@/api/lib/skill-package";

import {
  toParsedBundledSkillPackage,
  toParsedBundledSkillResources,
} from "./bundled-skill-resources";

/**
 * A catalogue skill resolved to its installable content plus the slug
 * it must be stored under. `installSlug` is always the catalogue
 * entry's slug — not the upstream `SKILL.md` frontmatter name, which
 * can differ for github-sourced skills. Storing the catalogue slug is
 * what lets install-state matching, re-install detection, and uninstall
 * find the row again.
 */
export type ResolvedCatalogueSkill = {
  installSlug: string;
  package: ParsedSkillPackage;
};

type FetchGithubCatalogueSkill = (options: {
  githubToken?: string;
  sourceUrl: string;
  target: GithubSkillPath;
}) => Promise<Result<ParsedSkillPackage, HandlerError>>;

type ResolveCatalogueSkillPackageOptions = {
  fetchGithubSkill?: FetchGithubCatalogueSkill;
  githubToken?: string;
};

type CreateGithubCataloguePackageCacheOptions = {
  fetchPackage?: FetchGithubCatalogueSkill;
  maxEntries?: number;
};

const DEFAULT_GITHUB_CATALOGUE_PACKAGE_CACHE_MAX_ENTRIES = 64;

/**
 * A bounded LRU cache for packages pinned to immutable Git commit SHAs.
 * In-flight requests share one traversal, failed requests are discarded, and
 * every caller receives a clone so mutation cannot corrupt cached content.
 */
export const createGithubCataloguePackageCache = ({
  fetchPackage = fetchGithubCatalogueSkillPackage,
  maxEntries = DEFAULT_GITHUB_CATALOGUE_PACKAGE_CACHE_MAX_ENTRIES,
}: CreateGithubCataloguePackageCacheOptions = {}): FetchGithubCatalogueSkill => {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    panic("GitHub catalogue package cache size must be a positive integer");
  }

  const entries = new Map<
    string,
    Promise<Result<ParsedSkillPackage, HandlerError>>
  >();

  return async (options) => {
    const key = githubCataloguePackageCacheKey(options.target);
    let pending = entries.get(key);
    if (pending) {
      entries.delete(key);
      entries.set(key, pending);
    } else {
      pending = fetchPackage(options);
      entries.set(key, pending);
      const oldestKey = entries.keys().next().value;
      if (entries.size > maxEntries && oldestKey !== undefined) {
        entries.delete(oldestKey);
      }
    }

    try {
      const result = await pending;
      if (Result.isError(result)) {
        if (entries.get(key) === pending) {
          entries.delete(key);
        }
        return Result.err(result.error);
      }
      return Result.ok(cloneParsedSkillPackage(result.value));
    } catch (error) {
      if (entries.get(key) === pending) {
        entries.delete(key);
      }
      throw error;
    }
  };
};

const fetchCachedGithubCatalogueSkillPackage =
  createGithubCataloguePackageCache();

/**
 * Resolve a catalogue skill slug to an installable package plus the
 * catalogue slug it installs under. In-tree skills are parsed from the
 * generated install-payload bundle (where name == slug is already
 * asserted); github-sourced skills carry no bundled payload, so their
 * whole directory is fetched from the pinned commit SHA. Either way the
 * returned `installSlug` is the catalogue slug, so an upstream
 * frontmatter name that differs from the slug never leaks into storage.
 * `fetchGithubSkill` is injectable so tests exercise the wiring without
 * the network.
 */
export const resolveCatalogueSkillPackage = async (
  slug: string,
  {
    fetchGithubSkill = fetchCachedGithubCatalogueSkillPackage,
    githubToken,
  }: ResolveCatalogueSkillPackageOptions = {},
): Promise<Result<ResolvedCatalogueSkill, HandlerError>> => {
  const payload = findCatalogueSkillInstallPayload(slug);
  if (payload) {
    const parsed = parseInTreeCatalogueSkill(payload);
    if (Result.isError(parsed)) {
      return Result.err(parsed.error);
    }
    return Result.ok({ installSlug: slug, package: parsed.value });
  }

  const entry = findCatalogueEntry("skill", slug);
  if (entry && isGithubSkillEntry(entry)) {
    const fetched = await fetchGithubSkill({
      ...(githubToken ? { githubToken } : {}),
      sourceUrl: githubRawContentBaseUrl(entry),
      target: githubSkillTargetFromEntry(entry),
    });
    if (Result.isError(fetched)) {
      return Result.err(fetched.error);
    }
    if (
      !catalogueLicensesMatch({
        catalogueLicense: entry.license,
        upstreamLicense: fetched.value.license,
      })
    ) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: `Catalogue skill license does not match its reviewed manifest: ${slug}`,
        }),
      );
    }
    return Result.ok({
      installSlug: slug,
      package: { ...fetched.value, license: entry.license },
    });
  }

  return Result.err(
    new HandlerError({
      status: 404,
      message: `Bundled skill not found in catalogue: ${slug}`,
    }),
  );
};

const githubCataloguePackageCacheKey = ({
  owner,
  ref,
  repo,
  rootPath,
}: GithubSkillPath): string => `${owner}/${repo}@${ref}:${rootPath}`;

const cloneParsedSkillPackage = (
  parsed: ParsedSkillPackage,
): ParsedSkillPackage => ({
  ...parsed,
  metadata: { ...parsed.metadata },
  resources: parsed.resources.map((resource) => ({ ...resource })),
});

/**
 * Build the pinned GitHub traversal target from a catalogue entry. The
 * schema guarantees `repo` is a single `owner/name` pair and `rev` is a
 * full commit SHA, so a malformed split is an internal invariant break,
 * not user input.
 */
const githubSkillTargetFromEntry = (
  entry: LoadedGithubSkillEntry,
): GithubSkillPath => {
  const [owner, repo] = entry.repo.split("/");
  if (!owner || !repo) {
    panic(`Catalogue github skill has a malformed repo: ${entry.repo}`);
  }
  return {
    owner,
    ref: entry.rev,
    repo,
    rootPath: entry.directory ?? "",
  };
};

export const parseInTreeCatalogueSkill = (
  payload: LoadedCatalogueSkillInstallPayload,
): Result<ParsedSkillPackage, HandlerError> => {
  const resourcesResult = toParsedBundledSkillResources(payload.resourceFiles);
  if (Result.isError(resourcesResult)) {
    return Result.err(resourcesResult.error);
  }

  return toParsedBundledSkillPackage({
    expectedSlug: payload.slug,
    resources: resourcesResult.value,
    source: payload.body,
  });
};
