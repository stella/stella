import { Result } from "better-result";
import { and, eq, isNull, or } from "drizzle-orm";
import * as v from "valibot";

import {
  MCP_RESPONSE_DISPOSITION,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { mcpConnectorRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { refreshCachedMcpToolsForConnection } from "@/api/lib/mcp-upstream/connections";
import { encryptMcpSecret } from "@/api/lib/mcp-upstream/crypto";
import {
  clientRegistrationMode,
  discoverOAuthMetadata,
} from "@/api/lib/mcp-upstream/oauth";

const requestBody = v.object({
  connectorSlug: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  token: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
});

const config = {
  contract: "patch",
  permissions: { integration: ["create"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: mcpConnectorRealtimeUpdates,
  mcp: { type: "internal", reason: "mcp_transport" },
  body: requestBody,
} satisfies HandlerConfig;

const createMcpConnection = createSafeRootHandler(
  config,
  async function* ({ body: input, recordAuditEvent, safeDb, session, user }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: mcpConnectors.id,
            authType: mcpConnectors.authType,
            url: mcpConnectors.url,
          })
          .from(mcpConnectors)
          .where(
            and(
              eq(mcpConnectors.slug, input.connectorSlug),
              or(
                isNull(mcpConnectors.organizationId),
                eq(mcpConnectors.organizationId, session.activeOrganizationId),
              ),
            ),
          )
          .limit(1),
      ),
    );

    const connector = rows.at(0);
    if (!connector) {
      return Result.err(
        new HandlerError({ status: 404, message: "MCP connector not found" }),
      );
    }

    yield* Result.await(
      assertStaticTokenAccepted({
        authType: connector.authType,
        url: connector.url,
      }),
    );

    const encrypted = await encryptMcpSecret({
      connectorId: connector.id,
      organizationId: session.activeOrganizationId,
      purpose: "mcp_static_token",
      secret: input.token.trim(),
      userId: user.id,
    });

    const saved = yield* Result.await(
      safeDb(async (tx) => {
        const upserted = await tx
          .insert(mcpUserConnections)
          .values({
            organizationId: session.activeOrganizationId,
            connectorId: connector.id,
            userId: user.id,
            staticTokenEncrypted: encrypted.ciphertext,
            staticTokenIv: encrypted.iv,
            status: "connected",
            responseDisposition: MCP_RESPONSE_DISPOSITION.normal,
            responseTargetUrl: null,
            enabled: true,
            tokenType: "Bearer",
          })
          .onConflictDoUpdate({
            target: [
              mcpUserConnections.organizationId,
              mcpUserConnections.connectorId,
              mcpUserConnections.userId,
            ],
            set: {
              accessTokenEncrypted: null,
              accessTokenIv: null,
              expiresAt: null,
              refreshTokenEncrypted: null,
              refreshTokenIv: null,
              resourceUrl: null,
              authorizationServerUrl: null,
              scope: null,
              staticTokenEncrypted: encrypted.ciphertext,
              staticTokenIv: encrypted.iv,
              cachedTools: null,
              cachedToolsRefreshedAt: null,
              status: "connected",
              responseDisposition: MCP_RESPONSE_DISPOSITION.normal,
              responseTargetUrl: null,
              enabled: true,
              tokenType: "Bearer",
              updatedAt: new Date(),
            },
          })
          .returning({
            id: mcpUserConnections.id,
            status: mcpUserConnections.status,
          });
        const row = upserted.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
            resourceId: row.id,
            workspaceId: null,
            metadata: {
              connectorId: connector.id,
              connectorSlug: input.connectorSlug,
              credential: "static_token",
            },
          });
        }
        return upserted;
      }),
    );

    const connection = saved.at(0);
    if (!connection) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to save MCP connection",
        }),
      );
    }

    await refreshCachedMcpToolsForConnection({
      connectionId: connection.id,
      organizationId: session.activeOrganizationId,
      permit: grantThirdPartyOutboundPermit(),
      safeDb,
      userId: user.id,
    });

    return Result.ok(connection);
  },
);

export default createMcpConnection;

const staticTokenRejected = () =>
  Result.err(
    new HandlerError({
      status: 400,
      message: "MCP connector does not accept a static token",
    }),
  );

// OAuth connectors normally must not bypass the consent flow with a
// pasted token. The exception is an authorization server with no client
// registration path (neither CIMD nor dynamic registration): stella
// cannot obtain a client_id there, so a pre-issued static token is the
// only way to connect. Re-checked here at the boundary instead of
// trusting state the connect endpoint derived earlier.
const assertStaticTokenAccepted = async ({
  authType,
  url,
}: {
  authType: typeof mcpConnectors.$inferSelect.authType;
  url: string;
}): Promise<Result<void, HandlerError<400>>> => {
  if (authType === "bearer") {
    return Result.ok(undefined);
  }
  if (authType !== "oauth2") {
    return staticTokenRejected();
  }

  const metadata = await discoverOAuthMetadata({
    rawMcpUrl: url,
    permit: grantThirdPartyOutboundPermit(),
  });
  if (Result.isError(metadata)) {
    return staticTokenRejected();
  }
  if (
    clientRegistrationMode(metadata.value.authorizationServer) !== "unsupported"
  ) {
    return staticTokenRejected();
  }

  return Result.ok(undefined);
};
