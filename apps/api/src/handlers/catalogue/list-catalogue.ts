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
import type { SafeId } from "@/api/lib/branded-types";
import { isBusinessRegistryNativeToolDeployAvailable } from "@/api/lib/business-registries/dispatch";
import { isWebSearchDeployAvailable } from "@/api/lib/web-search/select-provider";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

// Matches the cap on `GET /mcp/connectors`. The catalogue listing
// surfaces every org-owned custom connector as a synthetic entry,
// so the same bound applies — otherwise an org with thousands of
// custom MCPs could turn `/catalogue` into an unbounded read.
const ORG_CUSTOM_MCP_LIMIT = 100;

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
  /**
   * Whether the installed entry is currently enabled (turned on for
   * use in chat). Only meaningful when `installState === "installed"`.
   * For skills this mirrors `agentSkills.enabled`; for native-tools it
   * is always `true` when installed (install-state already encodes the
   * jurisdiction/override decision); for MCP entries this is `null`
   * because the user connection lives on a separate row and is
   * surfaced via the dedicated MCP detail flow.
   */
  enabled: boolean | null;
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
                  enabled: agentSkills.enabled,
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

    // Authored skills the user created via "Add custom skill" (and
    // legacy prompt_shortcuts migrated by the unification migration).
    // They have no curated catalogue entry, so the loop below would
    // miss them — append synthetic entries so the unified Tools page
    // can manage them after creation.
    const authoredSkillRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkills.id,
            slug: agentSkills.slug,
            scope: agentSkills.scope,
            enabled: agentSkills.enabled,
            name: agentSkills.name,
            description: agentSkills.description,
          })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.organizationId, session.activeOrganizationId),
              eq(agentSkills.origin, "authored"),
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

    // Org-owned MCP connectors that don't match any curated catalogue
    // entry URL. These are "custom" connectors the user added via the
    // old /knowledge/mcp page (or its successor); they need to show up
    // in /knowledge/tools so the user can manage them after the
    // surface unification. Capped to match /mcp/connectors so a large
    // org can't turn this endpoint into an unbounded read.
    const orgCustomMcps = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: mcpConnectors.id,
            slug: mcpConnectors.slug,
            displayName: mcpConnectors.displayName,
            description: mcpConnectors.description,
            url: mcpConnectors.url,
            authType: mcpConnectors.authType,
            isCurated: mcpConnectors.isCurated,
            oauthRequestedScopes: mcpConnectors.oauthRequestedScopes,
            allowedTools: mcpConnectors.allowedTools,
            documentationUrl: mcpConnectors.documentationUrl,
            tokenHelpUrl: mcpConnectors.tokenHelpUrl,
            iconUrl: mcpConnectors.iconUrl,
          })
          .from(mcpConnectors)
          .where(
            and(
              eq(mcpConnectors.organizationId, session.activeOrganizationId),
              eq(mcpConnectors.isCurated, false),
            ),
          )
          .orderBy(mcpConnectors.displayName, mcpConnectors.id)
          .limit(ORG_CUSTOM_MCP_LIMIT),
      ),
    );
    const curatedMcpUrlSet = new Set(mcpUrls);

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
    const skillEnabledBySlug = new Map<string, boolean>();
    for (const row of visibleSkillRows) {
      if (row.scope === "team" && !canDeleteTeamSkills) {
        continue;
      }
      const existing = skillIdBySlug.get(row.slug);
      if (!existing || row.scope === "team") {
        skillIdBySlug.set(row.slug, row.id);
        skillEnabledBySlug.set(row.slug, row.enabled);
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
      let enabled: boolean | null = null;
      if (installState === "installed") {
        if (entry.kind === "skill") {
          enabled = skillEnabledBySlug.get(entry.slug) ?? null;
        } else if (entry.kind === "native-tool") {
          // Native-tools encode the enabled decision into install-state
          // already (jurisdiction default + overrides). Installed ⇒ on.
          enabled = true;
        }
      }
      response.push({
        ...entry,
        isLocked,
        isRecommendedForOrg:
          installState !== "unavailable" && recommendedSlugs.has(entry.slug),
        installState,
        installedSkillId,
        installedConnectorSlug,
        enabled,
      });
    }

    // Append synthetic catalogue entries for the org's custom MCP
    // connectors that aren't represented by a curated catalogue entry.
    // The user already installed these directly, so install state is
    // always "installed" and the slug routes to the existing DELETE
    // /mcp/connectors/:slug uninstall handler.
    appendCustomMcpEntries({
      response,
      connectors: orgCustomMcps,
      curatedMcpUrls: curatedMcpUrlSet,
      organizationId: session.activeOrganizationId,
    });

    appendAuthoredSkillEntries({
      response,
      skills: authoredSkillRows,
      curatedSlugs: new Set(skillSlugs),
      canDeleteTeamSkills,
      organizationId: session.activeOrganizationId,
    });

    return Result.ok({
      entries: response,
      practiceJurisdictions,
    });
  },
);

type OrgCustomMcpRow = {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  url: string;
  authType: "none" | "bearer" | "oauth2";
  oauthRequestedScopes: string[] | null;
  allowedTools: string[] | null;
  documentationUrl: string | null;
  tokenHelpUrl: string | null;
  iconUrl: string | null;
};

type AppendCustomMcpArgs = {
  response: CatalogueEntryResponse[];
  connectors: readonly OrgCustomMcpRow[];
  curatedMcpUrls: ReadonlySet<string>;
  organizationId: SafeId<"organization">;
};

const appendCustomMcpEntries = ({
  response,
  connectors,
  curatedMcpUrls,
  organizationId,
}: AppendCustomMcpArgs): void => {
  for (const connector of connectors) {
    if (curatedMcpUrls.has(connector.url)) {
      continue;
    }
    response.push(buildCustomMcpCatalogueEntry(connector, organizationId));
  }
};

const buildCustomMcpCatalogueEntry = (
  connector: OrgCustomMcpRow,
  organizationId: SafeId<"organization">,
): CatalogueEntryResponse => {
  // DB stores `oauth2`; the curated catalogue schema uses `oauth`.
  // The auth flow is the same; only the literal differs.
  const catalogueAuthType =
    connector.authType === "oauth2" ? "oauth" : connector.authType;
  return {
    kind: "mcp",
    slug: connector.slug,
    displayName: connector.displayName,
    description: connector.description,
    author: organizationId,
    license: "MIT",
    cost: "free",
    setup: connector.authType === "none" ? "none" : "api-key",
    tags: [],
    jurisdictions: [],
    url: connector.url,
    authType: catalogueAuthType,
    oauthRequestedScopes: connector.oauthRequestedScopes ?? [],
    allowedTools: connector.allowedTools ?? [],
    ...(connector.documentationUrl !== null
      ? { documentationUrl: connector.documentationUrl }
      : {}),
    ...(connector.tokenHelpUrl !== null
      ? { tokenHelpUrl: connector.tokenHelpUrl }
      : {}),
    ...(connector.iconUrl !== null ? { iconUrl: connector.iconUrl } : {}),
    icon: null,
    isLocked: false,
    isRecommendedForOrg: false,
    installState: "installed",
    installedSkillId: null,
    installedConnectorSlug: connector.slug,
    enabled: null,
  };
};

type AuthoredSkillRow = {
  id: string;
  slug: string;
  scope: "team" | "private";
  enabled: boolean;
  name: string;
  description: string;
};

type AppendAuthoredSkillsArgs = {
  response: CatalogueEntryResponse[];
  skills: readonly AuthoredSkillRow[];
  curatedSlugs: ReadonlySet<string>;
  canDeleteTeamSkills: boolean;
  organizationId: SafeId<"organization">;
};

const appendAuthoredSkillEntries = ({
  response,
  skills,
  curatedSlugs,
  canDeleteTeamSkills,
  organizationId,
}: AppendAuthoredSkillsArgs): void => {
  // De-dupe by slug. A team-scope row and a private-scope row can
  // coexist (different uniqueness gates), but the catalogue surface
  // is keyed by slug, so we prefer the team row when both are visible
  // and the caller can delete it.
  const bySlug = new Map<string, AuthoredSkillRow>();
  for (const row of skills) {
    if (curatedSlugs.has(row.slug)) {
      continue;
    }
    if (row.scope === "team" && !canDeleteTeamSkills) {
      continue;
    }
    const existing = bySlug.get(row.slug);
    if (!existing || row.scope === "team") {
      bySlug.set(row.slug, row);
    }
  }
  for (const row of bySlug.values()) {
    response.push(buildAuthoredSkillCatalogueEntry(row, organizationId));
  }
};

const buildAuthoredSkillCatalogueEntry = (
  skill: AuthoredSkillRow,
  organizationId: SafeId<"organization">,
): CatalogueEntryResponse => ({
  kind: "skill",
  slug: skill.slug,
  displayName: skill.name,
  description: skill.description,
  author: organizationId,
  license: "MIT",
  cost: "free",
  setup: "none",
  tags: [],
  jurisdictions: [],
  entryPath: "",
  resources: [],
  icon: null,
  isLocked: false,
  isRecommendedForOrg: false,
  installState: "installed",
  installedSkillId: skill.id,
  installedConnectorSlug: null,
  enabled: skill.enabled,
});

export default listCatalogue;
