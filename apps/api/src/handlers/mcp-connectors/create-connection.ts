import { Result } from "better-result";
import { and, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import { mcpConnectors, mcpUserConnections } from "@/api/db/schema";
import { encryptMcpSecret } from "@/api/handlers/mcp-connectors/crypto";
import {
  clientRegistrationMode,
  discoverOAuthMetadata,
} from "@/api/handlers/mcp-connectors/oauth";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { refreshCachedMcpToolsForConnection } from "@/api/lib/mcp-upstream/connections";

const requestBody = t.Object({
  connectorSlug: t.String({ minLength: 1, maxLength: 80 }),
  token: t.String({ minLength: 1, maxLength: 4096 }),
});

const config = {
  permissions: { workspace: ["read"] },
  body: requestBody,
} satisfies HandlerConfig;

const createMcpConnection = createSafeRootHandler(
  config,
  async function* ({ body: input, safeDb, session, user }) {
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
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb(async (tx) => {
        // audit: skip — per-user MCP connection bearer-token registration; the connector itself is SOC 2-audited at create-connector / delete-connector.
        return await tx
          .insert(mcpUserConnections)
          .values({
            organizationId: session.activeOrganizationId,
            connectorId: connector.id,
            userId: user.id,
            staticTokenEncrypted: encrypted.ciphertext,
            staticTokenIv: encrypted.iv,
            status: "connected",
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
              enabled: true,
              tokenType: "Bearer",
              updatedAt: new Date(),
            },
          })
          .returning({
            id: mcpUserConnections.id,
            status: mcpUserConnections.status,
          });
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

  const metadata = await discoverOAuthMetadata(url);
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
