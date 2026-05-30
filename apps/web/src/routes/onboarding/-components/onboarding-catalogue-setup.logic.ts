import { recommendedSlugsForJurisdictions } from "@stll/catalogue";

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
