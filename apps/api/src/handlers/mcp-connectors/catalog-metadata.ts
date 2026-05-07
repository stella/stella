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

const SALVIA_RECOMMENDED_JURISDICTIONS = ["CZ"] as const;
const SALVIA_HOSTS = new Set(["mcp.slv.cz", "krajta.slv.cz"]);
const ARES_RECOMMENDED_JURISDICTIONS = ["CZ"] as const;
const NATIVE_TOOL_CATALOG = [
  {
    slug: "ares",
    displayName: "ARES",
    description:
      "Czech company lookup by IČO or company name from the public ARES register.",
    url: "https://ares.gov.cz",
    documentationUrl: "https://ares.gov.cz/stranky/vyvojar-info",
    iconUrl: "https://ares.gov.cz/favicon.ico",
    recommendedJurisdictions: [...ARES_RECOMMENDED_JURISDICTIONS],
  },
] satisfies NativeToolCatalogItem[];

export const mcpConnectorCatalogMetadata = (
  connector: McpConnectorCatalogSource,
): McpConnectorCatalogMetadata => {
  if (isSalviaConnector(connector)) {
    return { recommendedJurisdictions: [...SALVIA_RECOMMENDED_JURISDICTIONS] };
  }

  return { recommendedJurisdictions: [] };
};

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

  const practiceCountryCodes = new Set(
    practiceJurisdictions.map((jurisdiction) =>
      jurisdiction.countryCode.toUpperCase(),
    ),
  );

  return metadata.recommendedJurisdictions.some((countryCode) =>
    practiceCountryCodes.has(countryCode),
  );
};

export const getNativeToolCatalog = ({
  practiceJurisdictions,
}: {
  practiceJurisdictions: readonly PracticeJurisdiction[];
}) => {
  const practiceCountryCodes = new Set(
    practiceJurisdictions.map((jurisdiction) =>
      jurisdiction.countryCode.toUpperCase(),
    ),
  );

  return NATIVE_TOOL_CATALOG.map((tool) => ({
    description: tool.description,
    displayName: tool.displayName,
    documentationUrl: tool.documentationUrl,
    iconUrl: tool.iconUrl,
    isRecommended: tool.recommendedJurisdictions.some((countryCode) =>
      practiceCountryCodes.has(countryCode),
    ),
    recommendedJurisdictions: tool.recommendedJurisdictions,
    slug: tool.slug,
    url: tool.url,
  }));
};

const isSalviaConnector = ({
  displayName,
  slug,
  url,
}: McpConnectorCatalogSource): boolean => {
  const normalizedSlug = slug.toLowerCase();
  const normalizedName = displayName.toLowerCase();
  if (normalizedSlug.includes("salvia") || normalizedName.includes("salvia")) {
    return true;
  }

  try {
    const host = new URL(url).hostname.toLowerCase();
    return SALVIA_HOSTS.has(host);
  } catch {
    return false;
  }
};
