import { Result } from "better-result";

import {
  findCatalogueEntry,
  githubRawContentBaseUrl,
  isGithubSkillEntry,
} from "@stll/catalogue";
import type { LoadedCatalogueSkillInstallPayload } from "@stll/catalogue/install-payloads";
import { findCatalogueSkillInstallPayload } from "@stll/catalogue/install-payloads";

import { fetchGithubCatalogueSkillPackage } from "@/api/handlers/skills/skill-package";
import type { ParsedSkillPackage } from "@/api/handlers/skills/skill-package";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  toParsedBundledSkillPackage,
  toParsedBundledSkillResources,
} from "./bundled-skill-resources";

type FetchGithubCatalogueSkill = (
  rawContentBaseUrl: string,
) => Promise<Result<ParsedSkillPackage, HandlerError>>;

/**
 * Resolve a catalogue skill slug to an installable package. In-tree
 * skills are parsed from the generated install-payload bundle;
 * github-sourced skills carry no bundled payload, so their SKILL.md is
 * fetched from the pinned commit SHA. `fetchGithubSkill` is injectable
 * so tests exercise the wiring without the network.
 */
export const resolveCatalogueSkillPackage = async (
  slug: string,
  fetchGithubSkill: FetchGithubCatalogueSkill = fetchGithubCatalogueSkillPackage,
): Promise<Result<ParsedSkillPackage, HandlerError>> => {
  const payload = findCatalogueSkillInstallPayload(slug);
  if (payload) {
    return parseInTreeCatalogueSkill(payload);
  }

  const entry = findCatalogueEntry("skill", slug);
  if (entry && isGithubSkillEntry(entry)) {
    return await fetchGithubSkill(githubRawContentBaseUrl(entry));
  }

  return Result.err(
    new HandlerError({
      status: 404,
      message: `Bundled skill not found in catalogue: ${slug}`,
    }),
  );
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
