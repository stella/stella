import { loadCatalogue, type LoadedCatalogueEntry } from "@stll/catalogue";

import {
  collectJurisdictions,
  collectPracticeAreas,
} from "@/lib/tools-catalogue";

export const loadPublicToolsIndexData = () => {
  const entries = loadCatalogue();

  return {
    entries,
    practiceAreas: collectPracticeAreas(entries),
    jurisdictions: collectJurisdictions(entries),
  };
};

const findEntryBySlug = (slug: string): LoadedCatalogueEntry | undefined =>
  loadCatalogue().find((entry) => entry.slug === slug);

const loadSkillMarkdown = async (
  entry: LoadedCatalogueEntry,
): Promise<string | null> => {
  if (entry.kind !== "skill") {
    return null;
  }
  if (entry.source === "in-tree") {
    const { findCatalogueSkillInstallPayload } =
      await import("@stll/catalogue/install-payloads");
    return findCatalogueSkillInstallPayload(entry.slug)?.body ?? null;
  }
  const { loadGithubSkillMarkdown } =
    await import("@/lib/public-tools-github-content");
  return loadGithubSkillMarkdown(entry.slug);
};

export const loadPublicToolDetail = async (slug: string) => {
  const entry = findEntryBySlug(slug);
  if (!entry) {
    return null;
  }

  return {
    displayName: entry.displayName,
    entry,
    markdown: await loadSkillMarkdown(entry),
  };
};
