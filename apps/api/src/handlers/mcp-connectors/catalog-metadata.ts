import type { PracticeJurisdiction } from "@/api/db/schema";

type McpConnectorCatalogSource = {
  slug: string;
  displayName: string;
  url: string;
};

type McpConnectorCatalogMetadata = {
  recommendedJurisdictions: string[];
};

export type NativeToolCatalogItem = {
  slug: string;
  displayName: string;
  description: string;
  url: string;
  documentationUrl: string | null;
  iconUrl: string | null;
  recommendedJurisdictions: string[];
};

const ARES_RECOMMENDED_JURISDICTIONS = ["CZ"] as const;
const NATIVE_TOOL_CATALOG = [
  {
    slug: "ares",
    displayName: "ARES",
    description:
      "Czech company lookup by IČO or company name from the public ARES register.",
    url: "https://ares.gov.cz",
    documentationUrl: "https://ares.gov.cz/stranky/vyvojar-info",
    iconUrl: "https://ares.gov.cz/logo-ares-new.ico",
    recommendedJurisdictions: [...ARES_RECOMMENDED_JURISDICTIONS],
  },
] satisfies NativeToolCatalogItem[];

/** Authoritative slug list — independent of jurisdiction filtering. */
export const NATIVE_TOOL_SLUGS: readonly string[] = NATIVE_TOOL_CATALOG.map(
  (tool) => tool.slug,
);

const toPracticeCountryCodeSet = (
  practiceJurisdictions: readonly PracticeJurisdiction[],
): ReadonlySet<string> =>
  new Set(
    practiceJurisdictions.map((jurisdiction) =>
      jurisdiction.countryCode.toUpperCase(),
    ),
  );

const intersectsJurisdictions = (
  recommendedJurisdictions: readonly string[],
  practiceCountryCodes: ReadonlySet<string>,
): boolean => {
  if (recommendedJurisdictions.length === 0) {
    return true;
  }
  return recommendedJurisdictions.some((countryCode) =>
    practiceCountryCodes.has(countryCode.toUpperCase()),
  );
};

/**
 * Default-on iff the tool's recommended jurisdictions intersect the
 * org's practice jurisdictions (or the tool has no jurisdiction
 * recommendation, meaning it's globally relevant).
 */
const isNativeToolDefaultEnabledForCodes = (
  slug: string,
  practiceCountryCodes: ReadonlySet<string>,
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
  practiceCountryCodes: ReadonlySet<string>,
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
  return NATIVE_TOOL_CATALOG.filter(
    (tool) =>
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
    practiceCountryCodes.has(countryCode.toUpperCase()),
  );
};

export const getNativeToolCatalog = ({
  practiceJurisdictions,
}: {
  practiceJurisdictions: readonly PracticeJurisdiction[];
}) => {
  const practiceCountryCodes = toPracticeCountryCodeSet(practiceJurisdictions);

  return NATIVE_TOOL_CATALOG.map((tool) => ({
    description: tool.description,
    displayName: tool.displayName,
    documentationUrl: tool.documentationUrl,
    iconUrl: tool.iconUrl,
    isRecommended: tool.recommendedJurisdictions.some((countryCode) =>
      practiceCountryCodes.has(countryCode.toUpperCase()),
    ),
    recommendedJurisdictions: tool.recommendedJurisdictions,
    slug: tool.slug,
    url: tool.url,
  }));
};
