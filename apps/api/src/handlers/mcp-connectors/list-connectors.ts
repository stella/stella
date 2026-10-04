import { panic, Result } from "better-result";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import {
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
} from "@/api/db/schema";
import { mcpConnectorUrlIdentity } from "@/api/handlers/mcp-connectors/url-normalization";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { isBusinessRegistryNativeToolDeployAvailable } from "@/api/lib/business-registries/dispatch";
import { LIMITS } from "@/api/lib/limits";
import {
  getCuratedMcpOAuthApproval,
  getNativeToolCatalog,
  isMcpConnectorRecommendedForPractice,
  isNativeToolEnabledForOrg,
  mcpConnectorCatalogMetadata,
} from "@/api/lib/mcp-connectors/catalog-metadata";
import { resolveMcpIssuerBinding } from "@/api/lib/mcp-upstream/authorization-review";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

import createMcpConnector from "./create-connector";

const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "mcp_transport" },
  access: "read",
} satisfies HandlerConfig;

const listMcpConnectors = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, memberRole }) {
    const connectors = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: mcpConnectors.id,
            slug: mcpConnectors.slug,
            organizationId: mcpConnectors.organizationId,
            displayName: mcpConnectors.displayName,
            description: mcpConnectors.description,
            url: mcpConnectors.url,
            authType: mcpConnectors.authType,
            isCurated: mcpConnectors.isCurated,
            oauthRequestedScopes: mcpConnectors.oauthRequestedScopes,
            oauthIssuer: mcpConnectors.oauthIssuer,
            oauthConfirmedEndpointOrigins:
              mcpConnectors.oauthConfirmedEndpointOrigins,
            reviewApprovedIssuer:
              mcpConnectorAuthorizationReviews.approvedIssuer,
            reviewApprovedEndpointOrigins:
              mcpConnectorAuthorizationReviews.approvedEndpointOrigins,
            reviewObservedIssuer:
              mcpConnectorAuthorizationReviews.observedIssuer,
            reviewEndpointOrigins:
              mcpConnectorAuthorizationReviews.observedEndpointOrigins,
            allowedTools: mcpConnectors.allowedTools,
            documentationUrl: mcpConnectors.documentationUrl,
            tokenHelpUrl: mcpConnectors.tokenHelpUrl,
            iconUrl: mcpConnectors.iconUrl,
            authorizationReviewExists: sql<boolean>`coalesce(${mcpConnectorAuthorizationReviews.status} = 'needs_reapproval', false)`,
          })
          .from(mcpConnectors)
          .leftJoin(
            mcpConnectorAuthorizationReviews,
            and(
              eq(
                mcpConnectorAuthorizationReviews.connectorId,
                mcpConnectors.id,
              ),
              eq(
                mcpConnectorAuthorizationReviews.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .where(
            or(
              isNull(mcpConnectors.organizationId),
              eq(mcpConnectors.organizationId, session.activeOrganizationId),
            ),
          )
          .orderBy(desc(mcpConnectors.isCurated), mcpConnectors.displayName)
          .limit(LIMITS.mcpConnectorsPageSizeMax),
      ),
    );

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
    const practiceJurisdictions = arrayOrEmpty(settings?.practiceJurisdictions);
    const nativeToolOverrides = settings?.nativeToolOverrides ?? {};

    return Result.ok({
      canManageCustomConnectors: hasMemberPermission(
        memberRole,
        createMcpConnector.config.permissions,
      ),
      connectors: uniqueConnectorsByUrl(connectors).map((connector) => {
        const metadata = mcpConnectorCatalogMetadata(connector);
        return {
          id: connector.id,
          slug: connector.slug,
          organizationId: connector.organizationId,
          displayName: connector.displayName,
          description: connector.description,
          url: connector.url,
          authType: connector.authType,
          isCurated: connector.isCurated,
          oauthRequestedScopes: connector.oauthRequestedScopes,
          allowedTools: connector.allowedTools,
          documentationUrl: connector.documentationUrl,
          tokenHelpUrl: connector.tokenHelpUrl,
          iconUrl: connector.iconUrl,
          authorizationStatus: connectorAuthorizationStatus(connector),
          authorizationReview: pendingAuthorizationReview(connector),
          isRecommended: isMcpConnectorRecommendedForPractice({
            connector,
            practiceJurisdictions,
          }),
          recommendedJurisdictions: metadata.recommendedJurisdictions,
        };
      }),
      nativeTools: getNativeToolCatalog({
        nativeToolDeployAvailable: isBusinessRegistryNativeToolDeployAvailable,
        practiceJurisdictions,
      }).map((tool) => {
        const enabled = isNativeToolEnabledForOrg({
          slug: tool.slug,
          practiceJurisdictions,
          nativeToolOverrides,
        });
        return {
          description: tool.description,
          displayName: tool.displayName,
          documentationUrl: tool.documentationUrl,
          enabled,
          iconUrl: tool.iconUrl,
          isRecommended: tool.isRecommended,
          recommendedJurisdictions: tool.recommendedJurisdictions,
          slug: tool.slug,
          url: tool.url,
        };
      }),
    });
  },
);

export default listMcpConnectors;

const CONNECTOR_AUTHORIZATION_STATUS = {
  approved: "approved",
  needsReapproval: "needs_reapproval",
  notRequired: "not_required",
  unconfigured: "unconfigured",
} as const;

type ConnectorAuthorizationRow = {
  authType: typeof mcpConnectors.$inferSelect.authType;
  authorizationReviewExists: boolean;
  url: string;
  oauthIssuer: string | null;
  oauthConfirmedEndpointOrigins: string[] | null;
  reviewApprovedIssuer: string | null;
  reviewApprovedEndpointOrigins: string[] | null;
};

// Classified from the same binding connect and token use resolve, so an
// unconfigured issuer is reported before its first use records a review.
const connectorAuthorizationStatus = (connector: ConnectorAuthorizationRow) => {
  if (connector.authType !== "oauth2") {
    return CONNECTOR_AUTHORIZATION_STATUS.notRequired;
  }
  if (connector.authorizationReviewExists) {
    return CONNECTOR_AUTHORIZATION_STATUS.needsReapproval;
  }
  const binding = resolveMcpIssuerBinding({
    curatedApproval: getCuratedMcpOAuthApproval(connector.url),
    connectorIssuer: connector.oauthIssuer,
    connectorConfirmedEndpointOrigins: connector.oauthConfirmedEndpointOrigins,
    reviewApprovedIssuer: connector.reviewApprovedIssuer,
    reviewApprovedEndpointOrigins: connector.reviewApprovedEndpointOrigins,
  });
  switch (binding.type) {
    case "approved":
      return CONNECTOR_AUTHORIZATION_STATUS.approved;
    case "unconfigured":
      return CONNECTOR_AUTHORIZATION_STATUS.unconfigured;
    default:
      binding satisfies never;
      return panic("Unhandled issuer binding");
  }
};

type PendingAuthorizationReviewRow = {
  authorizationReviewExists: boolean;
  reviewObservedIssuer: string | null;
  reviewEndpointOrigins: string[] | null;
};

const pendingAuthorizationReview = ({
  authorizationReviewExists,
  reviewObservedIssuer,
  reviewEndpointOrigins,
}: PendingAuthorizationReviewRow) => {
  if (!authorizationReviewExists) {
    return null;
  }
  // The left join yields null only without a review row, and a stored review
  // always records its observed endpoint origins.
  if (reviewEndpointOrigins === null) {
    return panic("MCP authorization review has no observed endpoint origins");
  }
  return {
    issuer: reviewObservedIssuer,
    endpointOrigins: reviewEndpointOrigins,
  };
};

const uniqueConnectorsByUrl = <T extends { url: string }>(
  connectors: T[],
): T[] => {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const connector of connectors) {
    const identity = mcpConnectorUrlIdentity(connector.url);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    unique.push(connector);
  }
  return unique;
};
