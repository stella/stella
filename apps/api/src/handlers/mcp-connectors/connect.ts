import { Result } from "better-result";
import { and, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb, SafeDbError } from "@/api/db";
import {
  mcpConnectors,
  mcpOAuthClients,
  mcpOAuthState,
  mcpUserConnections,
} from "@/api/db/schema";
import { encryptMcpSecret } from "@/api/handlers/mcp-connectors/crypto";
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkce,
  discoverOAuthMetadata,
  getMcpOAuthRedirectUri,
  pickRequestedScopes,
  registerOAuthClient,
} from "@/api/handlers/mcp-connectors/oauth";
import { redactMcpOAuthRegistrationResponse } from "@/api/handlers/mcp-connectors/oauth-registration-response";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { refreshCachedMcpToolsForConnection } from "@/api/lib/mcp-upstream/connections";

const routeParams = t.Object({
  slug: t.String({ minLength: 1, maxLength: 80 }),
});

const config = {
  permissions: { workspace: ["read"] },
  params: routeParams,
} satisfies HandlerConfig;

type ConnectMcpConnectorResult =
  | { type: "bearer"; requiresToken: true }
  | { type: "none"; connected: true }
  | { type: "oauth2"; authorizeUrl: string };

const connectMcpConnector = createSafeRootHandler(
  config,
  async function* ({ params: requestParams, safeDb, session, user }) {
    const connector = yield* Result.await(
      loadConnector({
        safeDb,
        organizationId: session.activeOrganizationId,
        slug: requestParams.slug,
      }),
    );

    if (connector.authType === "bearer") {
      return Result.ok<ConnectMcpConnectorResult>({
        type: "bearer",
        requiresToken: true,
      });
    }

    if (connector.authType === "none") {
      const saved = yield* Result.await(
        // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
        safeDb((tx) => {
          // audit: skip — per-user MCP connection toggle; SOC 2 relevance lives at the connector-config layer (audited in create-connector / delete-connector).
          return tx
            .insert(mcpUserConnections)
            .values({
              organizationId: session.activeOrganizationId,
              connectorId: connector.id,
              userId: user.id,
              status: "connected",
              enabled: true,
            })
            .onConflictDoUpdate({
              target: [
                mcpUserConnections.organizationId,
                mcpUserConnections.connectorId,
                mcpUserConnections.userId,
              ],
              set: {
                status: "connected",
                enabled: true,
                accessTokenEncrypted: null,
                accessTokenIv: null,
                refreshTokenEncrypted: null,
                refreshTokenIv: null,
                staticTokenEncrypted: null,
                staticTokenIv: null,
                cachedTools: null,
                cachedToolsRefreshedAt: null,
                resourceUrl: null,
                authorizationServerUrl: null,
                updatedAt: new Date(),
              },
            })
            .returning({ id: mcpUserConnections.id });
        }),
      );

      const connection = saved.at(0);
      if (connection) {
        await refreshCachedMcpToolsForConnection({
          connectionId: connection.id,
          organizationId: session.activeOrganizationId,
          safeDb,
          userId: user.id,
        });
      }

      return Result.ok<ConnectMcpConnectorResult>({
        type: "none",
        connected: true,
      });
    }

    const metadata = yield* Result.await(discoverOAuthMetadata(connector.url));
    const redirectUri = getMcpOAuthRedirectUri();
    const requestedScopes = pickRequestedScopes({
      connectorScopes: connector.oauthRequestedScopes,
      protectedResource: metadata.protectedResource,
    });
    const client = yield* Result.await(
      ensureOAuthClient({
        connectorId: connector.id,
        connectorSlug: connector.slug,
        safeDb,
        organizationId: session.activeOrganizationId,
        redirectUri,
        authorizationServer: metadata.authorizationServer,
        requestedScopes,
      }),
    );
    const pkce = createPkce();
    const state = createOAuthState();

    yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — ephemeral OAuth state row consumed by the callback; the resulting connection is recorded at callback time.
        return tx.insert(mcpOAuthState).values({
          state,
          connectorId: connector.id,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          codeVerifier: pkce.codeVerifier,
          redirectUri,
          resourceUrl: metadata.protectedResource.resource,
          authorizationServerUrl: metadata.authorizationServer.issuer,
        });
      }),
    );

    const authorizeUrl = buildAuthorizeUrl({
      authorizationServer: metadata.authorizationServer,
      clientId: client.clientId,
      codeChallenge: pkce.codeChallenge,
      connectorSlug: connector.slug,
      protectedResource: metadata.protectedResource,
      redirectUri,
      requestedScopes,
      state,
    });

    return Result.ok<ConnectMcpConnectorResult>({
      type: "oauth2",
      authorizeUrl,
    });
  },
);

export default connectMcpConnector;

type LoadedConnector = {
  id: typeof mcpConnectors.$inferSelect.id;
  slug: string;
  authType: "none" | "bearer" | "oauth2";
  oauthRequestedScopes: string[] | null;
  url: string;
};

const loadConnector = async ({
  organizationId,
  safeDb,
  slug,
}: {
  organizationId: NonNullable<typeof mcpConnectors.$inferSelect.organizationId>;
  safeDb: SafeDb;
  slug: string;
}): Promise<Result<LoadedConnector, HandlerError<404> | SafeDbError>> => {
  const rows = await safeDb((tx) =>
    tx
      .select({
        id: mcpConnectors.id,
        slug: mcpConnectors.slug,
        authType: mcpConnectors.authType,
        oauthRequestedScopes: mcpConnectors.oauthRequestedScopes,
        url: mcpConnectors.url,
      })
      .from(mcpConnectors)
      .where(
        and(
          eq(mcpConnectors.slug, slug),
          or(
            isNull(mcpConnectors.organizationId),
            eq(mcpConnectors.organizationId, organizationId),
          ),
        ),
      )
      .limit(1),
  );

  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }

  const connector = rows.value.at(0);
  if (!connector) {
    return Result.err(
      new HandlerError({ status: 404, message: "MCP connector not found" }),
    );
  }

  return Result.ok(connector);
};

const ensureOAuthClient = async ({
  authorizationServer,
  connectorId,
  connectorSlug,
  organizationId,
  redirectUri,
  requestedScopes,
  safeDb,
}: {
  authorizationServer: Parameters<
    typeof registerOAuthClient
  >[0]["authorizationServer"];
  connectorId: typeof mcpConnectors.$inferSelect.id;
  connectorSlug: string;
  organizationId: NonNullable<typeof mcpConnectors.$inferSelect.organizationId>;
  redirectUri: string;
  requestedScopes: string[];
  safeDb: SafeDb;
}): Promise<
  Result<
    { clientId: string; clientSecret: string | null },
    HandlerError<502> | SafeDbError
  >
> =>
  await Result.gen(async function* () {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.mcpOAuthClients.findFirst({
          where: {
            organizationId: { eq: organizationId },
            connectorId: { eq: connectorId },
            authorizationServerUrl: { eq: authorizationServer.issuer },
          },
          columns: {
            clientId: true,
            clientSecretEncrypted: true,
            clientSecretIv: true,
          },
        }),
      ),
    );

    if (existing) {
      return Result.ok({
        clientId: existing.clientId,
        clientSecret: null,
      });
    }

    const registered = yield* Result.await(
      registerOAuthClient({
        authorizationServer,
        connectorSlug,
        redirectUri,
        requestedScopes,
      }),
    );
    const encryptedSecret = registered.clientSecret
      ? await encryptMcpSecret({
          connectorId,
          organizationId,
          purpose: "mcp_client_secret",
          secret: registered.clientSecret,
        })
      : null;

    const insertedClient = yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — Dynamic Client Registration metadata for the MCP authorization server; per-user connection state is the auditable surface.
        return tx
          .insert(mcpOAuthClients)
          .values({
            organizationId,
            connectorId,
            authorizationServerUrl: authorizationServer.issuer,
            clientId: registered.clientId,
            clientSecretEncrypted: encryptedSecret?.ciphertext ?? null,
            clientSecretIv: encryptedSecret?.iv ?? null,
            registrationResponse: redactMcpOAuthRegistrationResponse(
              registered.registrationResponse,
            ),
          })
          .onConflictDoNothing({
            target: [
              mcpOAuthClients.organizationId,
              mcpOAuthClients.connectorId,
              mcpOAuthClients.authorizationServerUrl,
            ],
          })
          .returning({
            clientId: mcpOAuthClients.clientId,
          });
      }),
    );

    if (insertedClient.length === 0) {
      const stored = yield* Result.await(
        safeDb((tx) =>
          tx.query.mcpOAuthClients.findFirst({
            where: {
              organizationId: { eq: organizationId },
              connectorId: { eq: connectorId },
              authorizationServerUrl: { eq: authorizationServer.issuer },
            },
            columns: {
              clientId: true,
              clientSecretEncrypted: true,
              clientSecretIv: true,
            },
          }),
        ),
      );

      if (stored) {
        return Result.ok({
          clientId: stored.clientId,
          clientSecret: null,
        });
      }

      return Result.err(
        new HandlerError({
          status: 502,
          message: "MCP OAuth client registration could not be persisted",
        }),
      );
    }

    return Result.ok({
      clientId: registered.clientId,
      clientSecret: registered.clientSecret,
    });
  });
