import {
  EU_MEMBER_STATES,
  filterCatalogueByKind,
  isToggleableNativeToolBackendSlug,
  loadRecommended,
} from "@stll/catalogue";
import { isCountryCode, type CountryCode } from "@stll/country-codes";

import type { PracticeJurisdiction } from "@/api/db/schema";

type McpConnectorCatalogSource = {
  slug: string;
  displayName: string;
  url: string;
};

type McpConnectorCatalogMetadata = {
  recommendedJurisdictions: readonly RecommendedJurisdictionCode[];
};

type RecommendedJurisdictionCode = CountryCode | "EU";

export type NativeToolCatalogItem = {
  slug: string;
  displayName: string;
  description: string;
  url: string;
  documentationUrl: string | null;
  iconUrl: string | null;
  recommendedJurisdictions: readonly RecommendedJurisdictionCode[];
};

const isRecommendedJurisdictionCode = (
  jurisdiction: string,
): jurisdiction is RecommendedJurisdictionCode =>
  jurisdiction === "EU" || isCountryCode(jurisdiction);

/**
 * Native-tool catalogue sourced from `@stll/catalogue`. Recommendation
 * lives in `packages/catalogue/entries/recommended.json` (maintainer-
 * curated, CODEOWNERS-gated). `recommendedJurisdictions` here is
 * derived: for each native-tool slug, which jurisdiction keys point to
 * it in `recommended.json`. Keeps the per-slug recommendation logic in
 * one place.
 */
const NATIVE_TOOL_CATALOG: readonly NativeToolCatalogItem[] = (() => {
  const recommended = loadRecommended();
  const jurisdictionsBySlug = new Map<string, RecommendedJurisdictionCode[]>();
  for (const [jurisdiction, slugs] of Object.entries(recommended)) {
    if (!isRecommendedJurisdictionCode(jurisdiction)) {
      continue;
    }
    for (const slug of slugs) {
      const list = jurisdictionsBySlug.get(slug) ?? [];
      list.push(jurisdiction);
      jurisdictionsBySlug.set(slug, list);
    }
  }

  return filterCatalogueByKind("native-tool").map((entry) => ({
    slug: entry.slug,
    displayName: entry.displayName,
    description: entry.description,
    url: entry.url ?? entry.homepage ?? "",
    documentationUrl: entry.documentationUrl ?? null,
    iconUrl: entry.iconUrl ?? null,
    recommendedJurisdictions: jurisdictionsBySlug.get(entry.slug) ?? [],
  }));
})();

/** Authoritative slug list — independent of jurisdiction filtering. */
export const NATIVE_TOOL_SLUGS: readonly string[] = NATIVE_TOOL_CATALOG.filter(
  (tool) => isToggleableNativeToolBackendSlug(tool.slug),
).map((tool) => tool.slug);

const toPracticeCountryCodeSet = (
  practiceJurisdictions: readonly PracticeJurisdiction[],
): ReadonlySet<CountryCode> =>
  new Set(
    practiceJurisdictions.map((jurisdiction) => jurisdiction.countryCode),
  );

const intersectsJurisdictions = (
  recommendedJurisdictions: readonly RecommendedJurisdictionCode[],
  practiceCountryCodes: ReadonlySet<CountryCode>,
): boolean => {
  if (recommendedJurisdictions.length === 0) {
    return true;
  }
  return recommendedJurisdictions.some((countryCode) =>
    matchesPracticeCountryCode(countryCode, practiceCountryCodes),
  );
};

const matchesPracticeCountryCode = (
  countryCode: RecommendedJurisdictionCode,
  practiceCountryCodes: ReadonlySet<CountryCode>,
): boolean => {
  if (countryCode !== "EU") {
    return practiceCountryCodes.has(countryCode);
  }

  for (const practiceCountryCode of practiceCountryCodes) {
    if (EU_MEMBER_STATES.has(practiceCountryCode)) {
      return true;
    }
  }

  return false;
};

/**
 * Default-on iff the tool's recommended jurisdictions intersect the
 * org's practice jurisdictions (or the tool has no jurisdiction
 * recommendation, meaning it's globally relevant).
 */
const isNativeToolDefaultEnabledForCodes = (
  slug: string,
  practiceCountryCodes: ReadonlySet<CountryCode>,
): boolean => {
  const tool = NATIVE_TOOL_CATALOG.find((entry) => entry.slug === slug);
  if (!tool) {
    return false;
  }
  return intersectsJurisdictions(
    tool.recommendedJurisdictions,
    practiceCountryCodes,
  );
};

const isNativeToolEnabledForCodes = (
  slug: string,
  practiceCountryCodes: ReadonlySet<CountryCode>,
  nativeToolOverrides: Readonly<Record<string, boolean>>,
): boolean => {
  const override = nativeToolOverrides[slug];
  if (typeof override === "boolean") {
    return override;
  }
  return isNativeToolDefaultEnabledForCodes(slug, practiceCountryCodes);
};

/**
 * Effective enabled state for a native tool. Explicit per-slug
 * overrides win over the jurisdiction-derived default, so a Czech
 * lawyer can still disable ARES and a Spanish lawyer can still
 * enable it on demand.
 */
export const isNativeToolEnabledForOrg = ({
  slug,
  practiceJurisdictions,
  nativeToolOverrides,
}: {
  slug: string;
  practiceJurisdictions: readonly PracticeJurisdiction[];
  nativeToolOverrides: Readonly<Record<string, boolean>>;
}): boolean =>
  isNativeToolEnabledForCodes(
    slug,
    toPracticeCountryCodeSet(practiceJurisdictions),
    nativeToolOverrides,
  );

export const getDisabledNativeToolSlugs = ({
  practiceJurisdictions,
  nativeToolOverrides,
}: {
  practiceJurisdictions: readonly PracticeJurisdiction[];
  nativeToolOverrides: Readonly<Record<string, boolean>>;
}): readonly string[] => {
  const practiceCountryCodes = toPracticeCountryCodeSet(practiceJurisdictions);
  const implementedSlugs = new Set(NATIVE_TOOL_SLUGS);
  return NATIVE_TOOL_CATALOG.filter(
    (tool) =>
      implementedSlugs.has(tool.slug) &&
      !isNativeToolEnabledForCodes(
        tool.slug,
        practiceCountryCodes,
        nativeToolOverrides,
      ),
  ).map((tool) => tool.slug);
};

export const mcpConnectorCatalogMetadata = (
  _connector: McpConnectorCatalogSource,
): McpConnectorCatalogMetadata => ({ recommendedJurisdictions: [] });

export const isMcpConnectorRecommendedForPractice = ({
  connector,
  practiceJurisdictions,
}: {
  connector: McpConnectorCatalogSource;
  practiceJurisdictions: readonly PracticeJurisdiction[];
}): boolean => {
  const metadata = mcpConnectorCatalogMetadata(connector);
  if (metadata.recommendedJurisdictions.length === 0) {
    return false;
  }

  const practiceCountryCodes = toPracticeCountryCodeSet(practiceJurisdictions);

  return metadata.recommendedJurisdictions.some((countryCode) =>
    matchesPracticeCountryCode(countryCode, practiceCountryCodes),
  );
};

export const getNativeToolCatalog = ({
  nativeToolDeployAvailable = () => true,
  practiceJurisdictions,
}: {
  nativeToolDeployAvailable?: (backendSlug: string) => boolean;
  practiceJurisdictions: readonly PracticeJurisdiction[];
}) => {
  const practiceCountryCodes = toPracticeCountryCodeSet(practiceJurisdictions);
  // Surface only implemented + toggleable tools. Pinned entries
  // (e.g. anonymize, create-docx) live in the catalogue but aren't
  // user-toggleable, so they must not appear in the MCP settings
  // toggle list — the PATCH endpoint would 404 on them.
  const toggleable = new Set(NATIVE_TOOL_SLUGS);

  return NATIVE_TOOL_CATALOG.filter(
    (tool) => toggleable.has(tool.slug) && nativeToolDeployAvailable(tool.slug),
  ).map((tool) => ({
    description: tool.description,
    displayName: tool.displayName,
    documentationUrl: tool.documentationUrl,
    iconUrl: tool.iconUrl,
    isRecommended: tool.recommendedJurisdictions.some((countryCode) =>
      matchesPracticeCountryCode(countryCode, practiceCountryCodes),
    ),
    recommendedJurisdictions: tool.recommendedJurisdictions,
    slug: tool.slug,
    url: tool.url,
  }));
};
