import { panic, Result } from "better-result";

import {
  findCatalogueEntry,
  githubRawContentBaseUrl,
  isGithubSkillEntry,
} from "@stll/catalogue";
import type { LoadedGithubSkillEntry } from "@stll/catalogue";
import type { LoadedCatalogueSkillInstallPayload } from "@stll/catalogue/install-payloads";
import { findCatalogueSkillInstallPayload } from "@stll/catalogue/install-payloads";

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
  sourceUrl: string;
  target: GithubSkillPath;
}) => Promise<Result<ParsedSkillPackage, HandlerError>>;

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
  fetchGithubSkill: FetchGithubCatalogueSkill = fetchGithubCatalogueSkillPackage,
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
      sourceUrl: githubRawContentBaseUrl(entry),
      target: githubSkillTargetFromEntry(entry),
    });
    if (Result.isError(fetched)) {
      return Result.err(fetched.error);
    }
    return Result.ok({ installSlug: slug, package: fetched.value });
  }

  return Result.err(
    new HandlerError({
      status: 404,
      message: `Bundled skill not found in catalogue: ${slug}`,
    }),
  );
};

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
