import { Result } from "better-result";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import {
  filterCatalogueByKind,
  loadCatalogue,
  recommendedSlugsForJurisdictions,
  type LoadedCatalogueEntry,
} from "@stll/catalogue";

import { agentSkills, mcpConnectors } from "@/api/db/schema";
import {
  computeCatalogueInstallState,
  type CatalogueInstallState,
} from "@/api/handlers/catalogue/install-state";
import { NATIVE_TOOL_SLUGS } from "@/api/handlers/mcp-connectors/catalog-metadata";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { isBusinessRegistryNativeToolDeployAvailable } from "@/api/lib/business-registries/dispatch";
import { isWebSearchDeployAvailable } from "@/api/lib/web-search/select-provider";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

type CatalogueEntryResponse = LoadedCatalogueEntry & {
  isRecommendedForOrg: boolean;
  installState: CatalogueInstallState;
  /**
   * True when the entry is a system capability the user cannot toggle
   * (non-toggleable pinned native-tools). UI hides install/uninstall
   * controls and renders the entry in the "Baseline" section.
   */
  isLocked: boolean;
  /**
   * Per-installation identifiers used by the uninstall path. Set only
   * when the entry is installed; `null` otherwise. Native-tools uninstall
   * via `backendSlug` so they don't need a separate handle here.
   */
  installedSkillId: string | null;
  installedConnectorSlug: string | null;
};

const listCatalogue = createSafeRootHandler(
  config,
  async function* ({ memberRole, safeDb, session, user }) {
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

    const visibleSkillRows =
      skillSlugs.length === 0
        ? []
        : yield* Result.await(
            safeDb((tx) =>
              tx
                .select({
                  id: agentSkills.id,
                  slug: agentSkills.slug,
                  scope: agentSkills.scope,
                })
                .from(agentSkills)
                .where(
                  and(
                    eq(
                      agentSkills.organizationId,
                      session.activeOrganizationId,
                    ),
                    inArray(agentSkills.slug, skillSlugs),
                    or(
                      eq(agentSkills.scope, "team"),
                      eq(agentSkills.userId, user.id),
                    ),
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
                .select({
                  url: mcpConnectors.url,
                  slug: mcpConnectors.slug,
                  organizationId: mcpConnectors.organizationId,
                })
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
    const installedSkillSlugs = new Set(
      visibleSkillRows.map((row) => row.slug),
    );
    const installedMcpUrls = new Set(installedMcps.map((row) => row.url));

    // Per-installation uninstall handles. We only surface a handle the
    // caller is actually allowed to delete:
    //
    // - Skills: team-scope rows require admin/owner role
    //   (`apps/api/src/handlers/skills/delete.ts`). Members get the
    //   user-scope row's ID, if any, or null. Prefer the team row when
    //   the caller is admin/owner.
    // - MCP connectors: `DELETE /mcp/connectors/:slug` only deletes
    //   org-owned rows, so globally-curated connectors (organizationId
    //   = null) never produce a usable slug.
    const canDeleteTeamSkills =
      memberRole.role === "admin" || memberRole.role === "owner";
    const skillIdBySlug = new Map<string, string>();
    for (const row of visibleSkillRows) {
      if (row.scope === "team" && !canDeleteTeamSkills) {
        continue;
      }
      const existing = skillIdBySlug.get(row.slug);
      if (!existing || row.scope === "team") {
        skillIdBySlug.set(row.slug, row.id);
      }
    }
    const connectorSlugByUrl = new Map<string, string>();
    for (const row of installedMcps) {
      if (row.organizationId !== session.activeOrganizationId) {
        continue;
      }
      connectorSlugByUrl.set(row.url, row.slug);
    }
    const nativeToolBackendSet = new Set(NATIVE_TOOL_SLUGS);
    const webSearchDeployAvailable = isWebSearchDeployAvailable();

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
        : computeCatalogueInstallState({
            entry,
            installedSkillSlugs,
            installedMcpUrls,
            nativeToolBackendSet,
            nativeToolDeployAvailable:
              isBusinessRegistryNativeToolDeployAvailable,
            nativeToolOverrides,
            practiceJurisdictions,
            webSearchDeployAvailable,
          });
      const installedSkillId =
        entry.kind === "skill" && installState === "installed"
          ? (skillIdBySlug.get(entry.slug) ?? null)
          : null;
      const installedConnectorSlug =
        entry.kind === "mcp" && installState === "installed"
          ? (connectorSlugByUrl.get(entry.url) ?? null)
          : null;
      response.push({
        ...entry,
        isLocked,
        isRecommendedForOrg:
          installState !== "unavailable" && recommendedSlugs.has(entry.slug),
        installState,
        installedSkillId,
        installedConnectorSlug,
      });
    }

    return Result.ok({
      entries: response,
      practiceJurisdictions,
    });
  },
);

export default listCatalogue;
