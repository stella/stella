import {
  EU_MEMBER_STATES,
  isToggleableNativeToolBackendSlug,
  recommendedSlugsForJurisdictions,
} from "@stll/catalogue";

import type { PracticeJurisdiction } from "@/lib/jurisdictions";

type CatalogueSetupEntry =
  | {
      kind: "native-tool";
      slug: string;
      backendSlug: string;
      pinned?: boolean;
    }
  | {
      kind: "mcp" | "skill";
      slug: string;
    };

type NativeToolOptOut = {
  backendSlug: string;
  slug: string;
};

export type CatalogueSetupPlan = {
  installSlugs: readonly string[];
  nativeToolOptOuts: readonly NativeToolOptOut[];
};

type CreateCatalogueSetupPlanOptions = {
  entries: readonly CatalogueSetupEntry[];
  practiceJurisdictions: readonly PracticeJurisdiction[];
  selectedSlugs: readonly string[];
};

type CatalogueSelectionEntry = {
  jurisdictions: readonly string[];
  slug: string;
};

type ReconcileCatalogueSlugsOptions = {
  entries: readonly CatalogueSelectionEntry[];
  practiceJurisdictions: readonly PracticeJurisdiction[];
  selectedSlugs: readonly string[];
};

type CatalogueAutoSelectionEntry = {
  author: string;
  slug: string;
};

// Onboarding reads the static catalogue before it can ask the API
// which server-config-gated tools are available for this deployment.
const ONBOARDING_HIDDEN_NATIVE_TOOL_BACKEND_SLUGS = new Set(["edgar"]);

export const isCatalogueEntryAvailableDuringOnboarding = (
  entry: CatalogueSetupEntry,
): boolean =>
  entry.kind !== "native-tool" ||
  !ONBOARDING_HIDDEN_NATIVE_TOOL_BACKEND_SLUGS.has(entry.backendSlug);

export type CatalogueAutoSelectionPlan = {
  addedSlugs: readonly string[];
  selectedSlugs: readonly string[];
};

type CreateCatalogueAutoSelectionPlanOptions = {
  recommendedEntries: readonly CatalogueAutoSelectionEntry[];
  removedSlugs: readonly string[];
  selectedSlugs: readonly string[];
};

const jurisdictionFilterForPractice = (
  practiceJurisdictions: readonly PracticeJurisdiction[],
): ReadonlySet<string> => {
  const scope = new Set<string>();
  let touchesEu = false;

  for (const jurisdiction of practiceJurisdictions) {
    const code = jurisdiction.countryCode.toUpperCase();
    scope.add(code);
    if (EU_MEMBER_STATES.has(code)) {
      touchesEu = true;
    }
  }

  if (touchesEu) {
    scope.add("EU");
  }

  return scope;
};

export const reconcileCatalogueSlugsForJurisdictions = ({
  entries,
  practiceJurisdictions,
  selectedSlugs,
}: ReconcileCatalogueSlugsOptions): readonly string[] => {
  const jurisdictionFilter = jurisdictionFilterForPractice(
    practiceJurisdictions,
  );
  const entriesBySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const reconciled: string[] = [];
  const seen = new Set<string>();

  for (const slug of selectedSlugs) {
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);

    const entry = entriesBySlug.get(slug);
    if (!entry) {
      continue;
    }
    if (entry.jurisdictions.length === 0) {
      reconciled.push(slug);
      continue;
    }
    if (jurisdictionFilter.size === 0) {
      continue;
    }
    if (
      entry.jurisdictions.some((jurisdiction) =>
        jurisdictionFilter.has(jurisdiction.toUpperCase()),
      )
    ) {
      reconciled.push(slug);
    }
  }

  return reconciled;
};

export const createCatalogueAutoSelectionPlan = ({
  recommendedEntries,
  removedSlugs,
  selectedSlugs,
}: CreateCatalogueAutoSelectionPlanOptions): CatalogueAutoSelectionPlan => {
  const removedSet = new Set(removedSlugs);
  const selectedSet = new Set(selectedSlugs);
  const addedSlugs: string[] = [];

  for (const entry of recommendedEntries) {
    if (entry.author !== "stella") {
      continue;
    }
    if (removedSet.has(entry.slug) || selectedSet.has(entry.slug)) {
      continue;
    }

    selectedSet.add(entry.slug);
    addedSlugs.push(entry.slug);
  }

  return {
    addedSlugs,
    selectedSlugs: addedSlugs.length === 0 ? selectedSlugs : [...selectedSet],
  };
};

export const createCatalogueSetupPlan = ({
  entries,
  practiceJurisdictions,
  selectedSlugs,
}: CreateCatalogueSetupPlanOptions): CatalogueSetupPlan => {
  const entriesBySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const installSlugs: string[] = [];
  const seenInstallSlugs = new Set<string>();
  for (const slug of selectedSlugs) {
    if (seenInstallSlugs.has(slug)) {
      continue;
    }
    seenInstallSlugs.add(slug);

    const entry = entriesBySlug.get(slug);
    if (entry && !isCatalogueEntryAvailableDuringOnboarding(entry)) {
      continue;
    }

    installSlugs.push(slug);
  }
  const selectedSlugSet = new Set(installSlugs);
  const recommendedSlugs = recommendedSlugsForJurisdictions(
    new Set(
      practiceJurisdictions.map((jurisdiction) =>
        jurisdiction.countryCode.toUpperCase(),
      ),
    ),
  );
  const nativeToolOptOuts: NativeToolOptOut[] = [];

  for (const entry of entries) {
    if (entry.kind !== "native-tool") {
      continue;
    }
    if (!isToggleableNativeToolBackendSlug(entry.backendSlug)) {
      continue;
    }
    if (entry.pinned) {
      continue;
    }
    if (selectedSlugSet.has(entry.slug)) {
      continue;
    }
    if (!recommendedSlugs.has(entry.slug)) {
      continue;
    }

    nativeToolOptOuts.push({
      backendSlug: entry.backendSlug,
      slug: entry.slug,
    });
  }

  return { installSlugs, nativeToolOptOuts };
};
