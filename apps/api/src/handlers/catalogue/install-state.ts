import type { PracticeJurisdiction } from "@/api/db/schema";
import { isNativeToolEnabledForOrg } from "@/api/handlers/mcp-connectors/catalog-metadata";

export type CatalogueInstallState = "installed" | "available" | "unavailable";

type CatalogueInstallStateEntry =
  | {
      kind: "skill";
      slug: string;
    }
  | {
      kind: "mcp";
      url: string;
    }
  | {
      backendSlug: string;
      kind: "native-tool";
    };

type ComputeCatalogueInstallStateOptions = {
  entry: CatalogueInstallStateEntry;
  installedSkillSlugs: ReadonlySet<string>;
  installedMcpUrls: ReadonlySet<string>;
  nativeToolBackendSet: ReadonlySet<string>;
  nativeToolDeployAvailable?: (backendSlug: string) => boolean;
  nativeToolOverrides: Readonly<Record<string, boolean>>;
  practiceJurisdictions: readonly PracticeJurisdiction[];
  webSearchDeployAvailable: boolean;
};

const WEB_SEARCH_NATIVE_TOOL_SLUG = "web-search";

export const computeCatalogueInstallState = ({
  entry,
  installedSkillSlugs,
  installedMcpUrls,
  nativeToolBackendSet,
  nativeToolDeployAvailable = () => true,
  nativeToolOverrides,
  practiceJurisdictions,
  webSearchDeployAvailable,
}: ComputeCatalogueInstallStateOptions): CatalogueInstallState => {
  if (entry.kind === "skill") {
    return installedSkillSlugs.has(entry.slug) ? "installed" : "available";
  }
  if (entry.kind === "mcp") {
    return installedMcpUrls.has(entry.url) ? "installed" : "available";
  }
  if (!nativeToolBackendSet.has(entry.backendSlug)) {
    return "unavailable";
  }
  if (!nativeToolDeployAvailable(entry.backendSlug)) {
    return "unavailable";
  }
  if (
    entry.backendSlug === WEB_SEARCH_NATIVE_TOOL_SLUG &&
    !webSearchDeployAvailable
  ) {
    return "unavailable";
  }

  // Use the same effective-enabled rule as the chat runtime: an
  // explicit override wins, otherwise the jurisdiction default
  // decides. Without this, jurisdiction-defaulted tools (e.g. ARES
  // for a CZ practice) would falsely show as "available" until the
  // user writes a redundant override.
  return isNativeToolEnabledForOrg({
    slug: entry.backendSlug,
    practiceJurisdictions,
    nativeToolOverrides,
  })
    ? "installed"
    : "available";
};
