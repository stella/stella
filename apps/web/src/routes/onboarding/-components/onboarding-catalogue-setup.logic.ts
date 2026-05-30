import {
  EU_MEMBER_STATES,
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

export const createCatalogueSetupPlan = ({
  entries,
  practiceJurisdictions,
  selectedSlugs,
}: CreateCatalogueSetupPlanOptions): CatalogueSetupPlan => {
  const installSlugs = Array.from(new Set(selectedSlugs));
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
