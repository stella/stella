import { Result } from "better-result";
import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { mcpConnectors } from "@/api/db/schema";
import type { McpConnectorAuthType } from "@/api/db/schema";
import {
  connectorSlugCandidates,
  firstFreeConnectorSlug,
} from "@/api/handlers/mcp-connectors/connector-slug";
import { discoverMcpIconUrl } from "@/api/handlers/mcp-connectors/icons";
import { probeMcpServer } from "@/api/handlers/mcp-connectors/probe";
import type { McpProbeResult } from "@/api/handlers/mcp-connectors/probe";
import {
  mcpConnectorUrlVariants,
  normalizeMcpConnectorUrl,
} from "@/api/handlers/mcp-connectors/url-normalization";
import { mcpConnectorRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getCuratedMcpOAuthApproval } from "@/api/lib/mcp-connectors/catalog-metadata";
import { oauthDomainsMatch } from "@/api/lib/mcp-upstream/oauth";

const requestBody = t.Object({
  url: t.String({ minLength: 1, maxLength: 2048 }),
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 160 })),
  description: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
  confirmedIssuer: t.Optional(t.String({ maxLength: 2048 })),
  confirmedEndpointOrigins: t.Optional(
    t.Array(t.String({ maxLength: 2048 }), { maxItems: 3 }),
  ),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: mcpConnectorRealtimeUpdates,
  mcp: { type: "internal", reason: "mcp_transport" },
  body: requestBody,
} satisfies HandlerConfig;

type CreateMcpConnectorDependencies = {
  probeServer: typeof probeMcpServer;
  discoverIconUrl: typeof discoverMcpIconUrl;
};

type CreateMcpConnectorResult =
  | {
      type: "confirmation_required";
      issuer: string;
      endpointOrigins: string[];
    }
  | {
      type: "created";
      connector: {
        id: SafeId<"mcpConnector">;
        slug: string;
        authType: McpConnectorAuthType;
      };
      probe: McpProbeResult;
    };

export const createMcpConnectorHandler = ({
  probeServer,
  discoverIconUrl,
}: CreateMcpConnectorDependencies) =>
  createSafeRootHandler(
    config,
    async function* ({
      body: input,
      safeDb,
      session,
      recordAuditEvent,
    }): SafeHandlerGenerator<CreateMcpConnectorResult> {
      const normalizedUrl = yield* normalizeMcpConnectorUrl(input.url);
      const duplicate = yield* Result.await(
        findDuplicateConnector({
          normalizedUrl,
          organizationId: session.activeOrganizationId,
          safeDb,
        }),
      );
      if (duplicate) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: `MCP connector already exists: ${duplicate.displayName}`,
          }),
        );
      }

      // Cap custom connectors per org so the catalogue listing (which bounds its
      // own read at `mcpConnectorsPageSizeMax`) never silently drops an org's own
      // connector out of the management UI. Curated connectors have a null
      // organizationId, so this counts only this org's custom rows.
      const [connectorCountRow] = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ total: count() })
            .from(mcpConnectors)
            .where(
              eq(mcpConnectors.organizationId, session.activeOrganizationId),
            ),
        ),
      );
      if (
        (connectorCountRow?.total ?? 0) >= LIMITS.mcpCustomConnectorsPerOrgMax
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: `MCP connector limit reached (${LIMITS.mcpCustomConnectorsPerOrgMax})`,
          }),
        );
      }

      const probeResult = await probeServer(normalizedUrl);
      if (Result.isError(probeResult)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: probeResult.error.message,
            cause: probeResult.error,
          }),
        );
      }
      const probe = probeResult.value;
      const curatedApproval = getCuratedMcpOAuthApproval(normalizedUrl);
      const curatedConfirmed =
        probe.authType === "oauth2" &&
        curatedApproval?.issuer === probe.authorizationServerUrl &&
        probe.endpointOrigins.every((origin) =>
          curatedApproval.endpointOrigins.includes(origin),
        );
      const issuerConfirmed =
        curatedConfirmed ||
        (probe.authType === "oauth2" &&
          input.confirmedIssuer === probe.authorizationServerUrl &&
          input.confirmedEndpointOrigins?.length ===
            probe.endpointOrigins.length &&
          probe.endpointOrigins.every((origin) =>
            input.confirmedEndpointOrigins?.includes(origin),
          ));
      if (
        probe.authType === "oauth2" &&
        (!oauthDomainsMatch(normalizedUrl, probe.authorizationServerUrl) ||
          probe.endpointOriginsRequiringConfirmation.length > 0) &&
        !issuerConfirmed
      ) {
        return Result.ok({
          type: "confirmation_required",
          issuer: probe.authorizationServerUrl,
          endpointOrigins: probe.endpointOrigins,
        });
      }
      const displayName =
        input.displayName?.trim() || new URL(normalizedUrl).hostname;
      const [slug, iconUrl] = await Promise.all([
        nextSlug({
          base: slugify(displayName),
          organizationId: session.activeOrganizationId,
          safeDb,
        }),
        discoverIconUrl(normalizedUrl),
      ]);

      const inserted = yield* Result.await(
        safeDb(async (tx) => {
          const rows = await tx
            .insert(mcpConnectors)
            .values({
              slug,
              organizationId: session.activeOrganizationId,
              displayName,
              description: input.description?.trim() ?? "",
              url: normalizedUrl,
              authType: probe.authType,
              isCurated: false,
              oauthRequestedScopes:
                probe.authType === "oauth2" && probe.scopes.length > 0
                  ? probe.scopes
                  : null,
              oauthIssuer:
                probe.authType === "oauth2"
                  ? probe.authorizationServerUrl
                  : null,
              oauthConfirmedEndpointOrigins:
                probe.authType === "oauth2" && issuerConfirmed
                  ? probe.endpointOrigins
                  : null,
              iconUrl,
            })
            .returning({
              id: mcpConnectors.id,
              slug: mcpConnectors.slug,
              authType: mcpConnectors.authType,
            });

          const row = rows.at(0);
          if (row) {
            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.CREATE,
              resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
              resourceId: session.activeOrganizationId,
              metadata: {
                field: "mcpConnector",
                connectorId: row.id,
                slug: row.slug,
                displayName,
                url: normalizedUrl,
                authType: row.authType,
              },
            });
          }

          return rows;
        }),
      );

      const connector = inserted.at(0);
      if (!connector) {
        return Result.err(
          new HandlerError({
            status: 500,
            message: "Failed to create MCP connector",
          }),
        );
      }

      return Result.ok({ type: "created", connector, probe });
    },
  );

export default createMcpConnectorHandler({
  probeServer: probeMcpServer,
  discoverIconUrl: discoverMcpIconUrl,
});

const findDuplicateConnector = async ({
  normalizedUrl,
  organizationId,
  safeDb,
}: {
  normalizedUrl: string;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
}) => {
  const urlVariants = mcpConnectorUrlVariants(normalizedUrl);
  const result = await safeDb((tx) =>
    tx
      .select({
        displayName: mcpConnectors.displayName,
      })
      .from(mcpConnectors)
      .where(
        and(
          inArray(mcpConnectors.url, urlVariants),
          or(
            isNull(mcpConnectors.organizationId),
            eq(mcpConnectors.organizationId, organizationId),
          ),
        ),
      )
      .limit(1),
  );

  if (Result.isError(result)) {
    return Result.err(result.error);
  }

  return Result.ok(result.value.at(0));
};

const slugify = (value: string): string => {
  let slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .slice(0, 60);

  while (slug.startsWith("-")) {
    slug = slug.slice(1);
  }
  while (slug.endsWith("-")) {
    slug = slug.slice(0, -1);
  }

  return slug || "mcp-server";
};

const nextSlug = async ({
  base,
  organizationId,
  safeDb,
}: {
  base: string;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
}) => {
  const candidates = connectorSlugCandidates(base);
  // One read for every candidate; distinct, because the same slug can be held
  // by a global connector and this organization's own.
  const taken = await safeDb((tx) =>
    tx
      .selectDistinct({ slug: mcpConnectors.slug })
      .from(mcpConnectors)
      .where(
        and(
          inArray(mcpConnectors.slug, candidates),
          or(
            isNull(mcpConnectors.organizationId),
            eq(mcpConnectors.organizationId, organizationId),
          ),
        ),
      )
      .limit(candidates.length),
  );

  if (Result.isError(taken)) {
    throw taken.error;
  }

  return firstFreeConnectorSlug({
    base,
    candidates,
    taken: new Set(taken.value.map((row) => row.slug)),
  });
};
