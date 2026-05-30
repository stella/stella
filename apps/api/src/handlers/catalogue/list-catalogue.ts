import { Result } from "better-result";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import {
  filterCatalogueByKind,
  loadCatalogue,
  recommendedSlugsForJurisdictions,
  type LoadedCatalogueEntry,
} from "@stll/catalogue";

import {
  agentSkills,
  mcpConnectors,
  type PracticeJurisdiction,
} from "@/api/db/schema";
import {
  isNativeToolEnabledForOrg,
  NATIVE_TOOL_SLUGS,
} from "@/api/handlers/mcp-connectors/catalog-metadata";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

type InstallState = "installed" | "available" | "unavailable";

type PublicCatalogueEntry<
  T extends LoadedCatalogueEntry = LoadedCatalogueEntry,
> = T extends LoadedCatalogueEntry ? Omit<T, "body" | "resourceFiles"> : never;

type CatalogueEntryResponse = PublicCatalogueEntry & {
  isRecommendedForOrg: boolean;
  installState: InstallState;
  /**
   * True when the entry is a system capability the user cannot toggle
   * (non-toggleable pinned native-tools). UI hides install/uninstall
   * controls and renders the entry in the "Baseline" section.
   */
  isLocked: boolean;
};

const toPublicCatalogueEntry = ({
  body: _body,
  resourceFiles: _resourceFiles,
  ...entry
}: LoadedCatalogueEntry): PublicCatalogueEntry => entry;

const listCatalogue = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const entries = loadCatalogue();
    const skillSlugs = entries
      .filter((entry) => entry.kind === "skill")
      .map((entry) => entry.slug);
    const mcpUrls = filterCatalogueByKind("mcp").map((entry) => entry.url);

    const settings = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: {
            practiceJurisdictions: true,
            nativeToolOverrides: true,
          },
        }),
      ),
    );

    const installedSkills =
      skillSlugs.length === 0
        ? []
        : yield* Result.await(
            safeDb((tx) =>
              tx
                .select({ slug: agentSkills.slug })
                .from(agentSkills)
                .where(
                  and(
                    eq(
                      agentSkills.organizationId,
                      session.activeOrganizationId,
                    ),
                    eq(agentSkills.origin, "bundled"),
                    inArray(agentSkills.slug, skillSlugs),
                  ),
                ),
            ),
          );

    const installedMcps =
      mcpUrls.length === 0
        ? []
        : yield* Result.await(
            safeDb((tx) =>
              tx
                .select({ url: mcpConnectors.url })
                .from(mcpConnectors)
                .where(
                  and(
                    or(
                      isNull(mcpConnectors.organizationId),
                      eq(
                        mcpConnectors.organizationId,
                        session.activeOrganizationId,
                      ),
                    ),
                    inArray(mcpConnectors.url, mcpUrls),
                  ),
                ),
            ),
          );

    const practiceJurisdictions = settings?.practiceJurisdictions ?? [];
    const nativeToolOverrides = settings?.nativeToolOverrides ?? {};
    const practiceCountryCodes = new Set(
      practiceJurisdictions.map((jurisdiction) =>
        jurisdiction.countryCode.toUpperCase(),
      ),
    );
    const recommendedSlugs =
      recommendedSlugsForJurisdictions(practiceCountryCodes);
    const installedSkillSlugs = new Set(installedSkills.map((row) => row.slug));
    const installedMcpUrls = new Set(installedMcps.map((row) => row.url));
    const nativeToolBackendSet = new Set(NATIVE_TOOL_SLUGS);

    const response: CatalogueEntryResponse[] = [];
    for (const entry of entries) {
      // "Locked" means non-toggleable: pinned AND not in the
      // implemented-toggleable slug set. Pinned + toggleable (today:
      // web-search) still respects the org's enable/disable override
      // via computeInstallState below.
      const isLocked =
        entry.kind === "native-tool" &&
        entry.pinned &&
        !nativeToolBackendSet.has(entry.backendSlug);
      const installState = isLocked
        ? ("installed" as const)
        : computeInstallState({
            entry,
            installedSkillSlugs,
            installedMcpUrls,
            nativeToolBackendSet,
            nativeToolOverrides,
            practiceJurisdictions,
          });
      const publicEntry = toPublicCatalogueEntry(entry);
      response.push({
        ...publicEntry,
        isLocked,
        isRecommendedForOrg: recommendedSlugs.has(entry.slug),
        installState,
      });
    }

    return Result.ok({
      entries: response,
      practiceJurisdictions,
    });
  },
);

const computeInstallState = ({
  entry,
  installedSkillSlugs,
  installedMcpUrls,
  nativeToolBackendSet,
  nativeToolOverrides,
  practiceJurisdictions,
}: {
  entry: LoadedCatalogueEntry;
  installedSkillSlugs: ReadonlySet<string>;
  installedMcpUrls: ReadonlySet<string>;
  nativeToolBackendSet: ReadonlySet<string>;
  nativeToolOverrides: Readonly<Record<string, boolean>>;
  practiceJurisdictions: readonly PracticeJurisdiction[];
}): InstallState => {
  if (entry.kind === "skill") {
    return installedSkillSlugs.has(entry.slug) ? "installed" : "available";
  }
  if (entry.kind === "mcp") {
    return installedMcpUrls.has(entry.url) ? "installed" : "available";
  }
  if (!nativeToolBackendSet.has(entry.backendSlug)) {
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

export default listCatalogue;
