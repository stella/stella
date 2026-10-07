import { Result } from "better-result";
import { and, eq, exists, isNull, or, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
} from "@/api/db/schema";
import { mcpConnectorRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  discoverOAuthMetadataForApproval,
  getOAuthEndpointOrigins,
} from "@/api/lib/mcp-upstream/oauth";

const config = {
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: mcpConnectorRealtimeUpdates,
  mcp: { type: "internal", reason: "mcp_transport" },
  params: t.Object({ slug: t.String({ minLength: 1, maxLength: 80 }) }),
  body: t.Object({
    confirmedIssuer: t.String({ maxLength: 2048 }),
    confirmedEndpointOrigins: t.Array(t.String({ maxLength: 2048 }), {
      maxItems: 3,
    }),
  }),
} satisfies HandlerConfig;

export const createApproveMcpAuthorizationHandler = (
  discoverMetadata: typeof discoverOAuthMetadataForApproval,
) =>
  createSafeRootHandler(
    config,
    async function* ({
      body: confirmation,
      params: { slug },
      safeDb,
      session,
      recordAuditEvent,
    }) {
      const organizationId = session.activeOrganizationId;
      const [connector] = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              id: mcpConnectors.id,
              url: mcpConnectors.url,
              observedIssuer: mcpConnectorAuthorizationReviews.observedIssuer,
              observedEndpointOrigins:
                mcpConnectorAuthorizationReviews.observedEndpointOrigins,
              reviewVersion: sql<string>`${mcpConnectorAuthorizationReviews.updatedAt}::text`,
            })
            .from(mcpConnectors)
            .innerJoin(
              mcpConnectorAuthorizationReviews,
              and(
                eq(
                  mcpConnectorAuthorizationReviews.connectorId,
                  mcpConnectors.id,
                ),
                eq(
                  mcpConnectorAuthorizationReviews.organizationId,
                  organizationId,
                ),
                eq(mcpConnectorAuthorizationReviews.status, "needs_reapproval"),
              ),
            )
            .where(
              and(
                eq(mcpConnectors.slug, slug),
                eq(mcpConnectors.authType, "oauth2"),
                or(
                  isNull(mcpConnectors.organizationId),
                  eq(mcpConnectors.organizationId, organizationId),
                ),
              ),
            )
            .limit(1),
        ),
      );
      if (!connector) {
        return Result.err(
          new HandlerError({
            status: 404,
            message: "MCP authorization review not found",
          }),
        );
      }
      const metadata = yield* Result.await(discoverMetadata(connector.url));
      const issuer = metadata.authorizationServer.issuer;
      const endpointOrigins = getOAuthEndpointOrigins(metadata);
      if (
        issuer !== connector.observedIssuer ||
        confirmation.confirmedIssuer !== issuer ||
        endpointOrigins.length !==
          confirmation.confirmedEndpointOrigins.length ||
        endpointOrigins.some(
          (origin) => !confirmation.confirmedEndpointOrigins.includes(origin),
        ) ||
        endpointOrigins.length !== connector.observedEndpointOrigins.length ||
        endpointOrigins.some(
          (origin) => !connector.observedEndpointOrigins.includes(origin),
        )
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            code: "mcp_authorization_approval_required",
            message:
              "Connector authorization changed. Connect again before requesting approval.",
          }),
        );
      }
      const approved = yield* Result.await(
        safeDb(async (tx) => {
          const rows = await tx
            .update(mcpConnectorAuthorizationReviews)
            .set({
              approvedIssuer: issuer,
              approvedEndpointOrigins: endpointOrigins,
              status: "approved",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(
                  mcpConnectorAuthorizationReviews.organizationId,
                  organizationId,
                ),
                eq(mcpConnectorAuthorizationReviews.connectorId, connector.id),
                eq(mcpConnectorAuthorizationReviews.status, "needs_reapproval"),
                eq(mcpConnectorAuthorizationReviews.observedIssuer, issuer),
                eq(
                  mcpConnectorAuthorizationReviews.updatedAt,
                  sql`${connector.reviewVersion}::timestamptz`,
                ),
                exists(
                  tx
                    .select({ one: sql`1` })
                    .from(mcpConnectors)
                    .where(
                      and(
                        eq(mcpConnectors.id, connector.id),
                        eq(mcpConnectors.slug, slug),
                        eq(mcpConnectors.url, connector.url),
                        or(
                          isNull(mcpConnectors.organizationId),
                          eq(mcpConnectors.organizationId, organizationId),
                        ),
                      ),
                    ),
                ),
              ),
            )
            .returning({
              connectorId: mcpConnectorAuthorizationReviews.connectorId,
            });
          const row = rows.at(0);
          if (row) {
            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
              resourceId: organizationId,
              metadata: {
                field: "mcpConnectorAuthorization",
                connectorId: row.connectorId,
                slug,
              },
            });
          }
          return row;
        }),
      );
      if (!approved) {
        return Result.err(
          new HandlerError({
            status: 409,
            code: "mcp_authorization_approval_required",
            message: "Connector authorization changed. Request approval again.",
          }),
        );
      }
      return Result.ok({ approved: true });
    },
  );

export default createApproveMcpAuthorizationHandler(
  discoverOAuthMetadataForApproval,
);
