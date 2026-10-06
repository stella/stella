import { panic, Result } from "better-result";
import { and, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpOAuthClients,
  mcpOAuthState,
  mcpUserConnections,
} from "@/api/db/schema";
import { mcpConnectorRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getCuratedMcpOAuthApproval } from "@/api/lib/mcp-connectors/catalog-metadata";
import {
  recordMcpAuthorizationReview,
  resolveMcpIssuerBinding,
} from "@/api/lib/mcp-upstream/authorization-review";
import { refreshCachedMcpToolsForConnection } from "@/api/lib/mcp-upstream/connections";
import { encryptMcpSecret } from "@/api/lib/mcp-upstream/crypto";
import {
  MCP_OAUTH_BINDING_FAILURE_CODE,
  buildAuthorizeUrl,
  buildMcpClientMetadataDocument,
  clientRegistrationMode,
  createOAuthState,
  createPkce,
  discoverOAuthMetadataForApproval,
  bindDiscoveredMetadata,
  getOAuthEndpointOrigins,
  getMcpClientMetadataDocumentUrl,
  getMcpOAuthRedirectUri,
  mcpAuthorizationApprovalRequiredError,
  pickRequestedScopes,
  registerOAuthClient,
  validateApprovedOAuthIssuer,
} from "@/api/lib/mcp-upstream/oauth";
import type {
  BoundOAuthMetadata,
  McpClientRegistrationMode,
} from "@/api/lib/mcp-upstream/oauth";
import { redactMcpOAuthRegistrationResponse } from "@/api/lib/mcp-upstream/oauth-registration-response";

const routeParams = t.Object({
  slug: t.String({ minLength: 1, maxLength: 80 }),
});

const config = {
  permissions: { integration: ["create"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: mcpConnectorRealtimeUpdates,
  mcp: { type: "internal", reason: "mcp_transport" },
  params: routeParams,
} satisfies HandlerConfig;

type ConnectMcpConnectorResult =
  | { type: "bearer"; requiresToken: true }
  | { type: "none"; connected: true }
  | { type: "oauth2"; authorizeUrl: string };

type ConnectMcpConnectorDependencies = {
  discoverMetadata: typeof discoverOAuthMetadataForApproval;
  curatedOAuthApproval: typeof getCuratedMcpOAuthApproval;
};

export const createConnectMcpConnectorHandler = ({
  discoverMetadata,
  curatedOAuthApproval,
}: ConnectMcpConnectorDependencies) =>
  createSafeRootHandler(
    config,
    async function* ({
      params: requestParams,
      safeDb,
      session,
      user,
      recordAuditEvent,
    }) {
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
          safeDb((tx) =>
            // audit: skip — per-user MCP connection toggle; SOC 2 relevance lives at the connector-config layer (audited in create-connector / delete-connector).
            tx
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
              .returning({ id: mcpUserConnections.id }),
          ),
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

      const metadata = yield* Result.await(
        loadApprovedMcpMetadata({
          connector,
          discoverMetadata,
          curatedOAuthApproval,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          safeDb,
          recordAuditEvent,
        }),
      );

      // Servers that advertise OAuth but offer no client registration path
      // (neither CIMD nor dynamic registration) cannot complete stella's
      // OAuth flow; a pre-issued static token is the only way to connect.
      const registrationMode = clientRegistrationMode(
        metadata.authorizationServer,
      );
      if (registrationMode === "unsupported") {
        return Result.ok<ConnectMcpConnectorResult>({
          type: "bearer",
          requiresToken: true,
        });
      }

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
          metadata,
          registrationMode,
          requestedScopes,
        }),
      );
      const pkce = createPkce();
      const state = createOAuthState();

      yield* Result.await(
        safeDb((tx) =>
          // audit: skip — ephemeral OAuth state row consumed by the callback; the resulting connection is recorded at callback time.
          tx.insert(mcpOAuthState).values({
            state,
            connectorId: connector.id,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            codeVerifier: pkce.codeVerifier,
            redirectUri,
            resourceUrl: metadata.protectedResource.resource,
            authorizationServerUrl: metadata.authorizationServer.issuer,
          }),
        ),
      );

      const authorizeUrl = buildAuthorizeUrl({
        metadata,
        clientId: client.clientId,
        codeChallenge: pkce.codeChallenge,
        connectorSlug: connector.slug,
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

const connectMcpConnector = createConnectMcpConnectorHandler({
  discoverMetadata: discoverOAuthMetadataForApproval,
  curatedOAuthApproval: getCuratedMcpOAuthApproval,
});

export default connectMcpConnector;

type LoadedConnector = {
  id: typeof mcpConnectors.$inferSelect.id;
  slug: string;
  authType: "none" | "bearer" | "oauth2";
  oauthRequestedScopes: string[] | null;
  oauthIssuer: string | null;
  orgApprovedIssuer: string | null;
  orgApprovedEndpointOrigins: string[] | null;
  oauthConfirmedEndpointOrigins: string[] | null;
  authorizationReviewStatus:
    | typeof mcpConnectorAuthorizationReviews.$inferSelect.status
    | null;
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
        oauthIssuer: mcpConnectors.oauthIssuer,
        orgApprovedIssuer: mcpConnectorAuthorizationReviews.approvedIssuer,
        orgApprovedEndpointOrigins:
          mcpConnectorAuthorizationReviews.approvedEndpointOrigins,
        oauthConfirmedEndpointOrigins:
          mcpConnectors.oauthConfirmedEndpointOrigins,
        authorizationReviewStatus: mcpConnectorAuthorizationReviews.status,
        url: mcpConnectors.url,
      })
      .from(mcpConnectors)
      .leftJoin(
        mcpConnectorAuthorizationReviews,
        and(
          eq(mcpConnectorAuthorizationReviews.connectorId, mcpConnectors.id),
          eq(mcpConnectorAuthorizationReviews.organizationId, organizationId),
        ),
      )
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

type LoadApprovedMcpMetadataOptions = ConnectMcpConnectorDependencies & {
  connector: LoadedConnector;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
};

const loadApprovedMcpMetadata = async ({
  connector,
  discoverMetadata,
  curatedOAuthApproval,
  organizationId,
  userId,
  safeDb,
  recordAuditEvent,
}: LoadApprovedMcpMetadataOptions): Promise<
  Result<BoundOAuthMetadata, HandlerError<400 | 409 | 502> | SafeDbError>
> =>
  await Result.gen(async function* () {
    const discovery = await discoverMetadata(connector.url);
    if (Result.isError(discovery)) {
      if (discovery.error.code === MCP_OAUTH_BINDING_FAILURE_CODE) {
        yield* Result.await(
          recordMcpAuthorizationReview({
            safeDb,
            organizationId,
            userId,
            connectorId: connector.id,
            connection: { type: "mark" },
            recordAuditEvent,
            observedIssuer: connector.oauthIssuer,
          }),
        );
      }
      return Result.err(discovery.error);
    }
    const observed = discovery.value;
    const issuerBinding = resolveMcpIssuerBinding({
      curatedApproval: curatedOAuthApproval(connector.url),
      connectorIssuer: connector.oauthIssuer,
      connectorConfirmedEndpointOrigins:
        connector.oauthConfirmedEndpointOrigins,
      reviewApprovedIssuer: connector.orgApprovedIssuer,
      reviewApprovedEndpointOrigins: connector.orgApprovedEndpointOrigins,
    });
    switch (issuerBinding.type) {
      case "unconfigured":
        // Nothing approved an issuer yet: the observed one awaits an
        // administrator, who approves it for the whole organization.
        yield* Result.await(
          recordMcpAuthorizationReview({
            safeDb,
            organizationId,
            userId,
            connectorId: connector.id,
            connection: { type: "mark" },
            recordAuditEvent,
            observedIssuer: observed.authorizationServer.issuer,
            observedEndpointOrigins: getOAuthEndpointOrigins(observed),
          }),
        );
        return Result.err(mcpAuthorizationApprovalRequiredError());
      case "approved":
        break;
      default: {
        issuerBinding satisfies never;
        return panic("Unhandled MCP issuer binding");
      }
    }
    const binding = bindDiscoveredMetadata({
      connectorUrl: connector.url,
      protectedResource: observed.protectedResource,
      authorizationServer: observed.authorizationServer,
      confirmedEndpointOrigins: issuerBinding.endpointOrigins,
    });
    if (Result.isError(binding)) {
      yield* Result.await(
        recordMcpAuthorizationReview({
          safeDb,
          organizationId,
          userId,
          connectorId: connector.id,
          connection: { type: "mark" },
          recordAuditEvent,
          observedIssuer: observed.authorizationServer.issuer,
          observedEndpointOrigins: getOAuthEndpointOrigins(observed),
        }),
      );
      return Result.err(binding.error);
    }
    const metadata = binding.value;
    const approval = validateApprovedOAuthIssuer(metadata, issuerBinding);
    if (
      Result.isError(approval) ||
      connector.authorizationReviewStatus === "needs_reapproval"
    ) {
      yield* Result.await(
        recordMcpAuthorizationReview({
          safeDb,
          organizationId,
          userId,
          connectorId: connector.id,
          connection: { type: "mark" },
          recordAuditEvent,
          observedIssuer: metadata.authorizationServer.issuer,
          observedEndpointOrigins: getOAuthEndpointOrigins(metadata),
        }),
      );
      return Result.err(
        Result.isError(approval)
          ? approval.error
          : mcpAuthorizationApprovalRequiredError(),
      );
    }

    return Result.ok(metadata);
  });

type EnsureOAuthClientOptions = {
  metadata: Parameters<typeof registerOAuthClient>[0]["metadata"];
  connectorId: typeof mcpConnectors.$inferSelect.id;
  connectorSlug: string;
  organizationId: NonNullable<typeof mcpConnectors.$inferSelect.organizationId>;
  redirectUri: string;
  registrationMode: Exclude<McpClientRegistrationMode, "unsupported">;
  requestedScopes: string[];
  safeDb: SafeDb;
};

const ensureOAuthClient = async ({
  metadata,
  connectorId,
  connectorSlug,
  organizationId,
  redirectUri,
  registrationMode,
  requestedScopes,
  safeDb,
}: EnsureOAuthClientOptions): Promise<
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
            authorizationServerUrl: { eq: metadata.authorizationServer.issuer },
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

    // CIMD: the document URL is the client_id; the authorization server
    // fetches the metadata itself, so no registration round-trip happens.
    const registered =
      registrationMode === "cimd"
        ? {
            clientId: getMcpClientMetadataDocumentUrl(),
            clientSecret: null,
            registrationResponse: redactMcpOAuthRegistrationResponse(
              buildMcpClientMetadataDocument(),
            ),
          }
        : yield* Result.await(
            registerOAuthClient({
              metadata,
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
      safeDb((tx) =>
        // audit: skip — Dynamic Client Registration metadata for the MCP authorization server; per-user connection state is the auditable surface.
        tx
          .insert(mcpOAuthClients)
          .values({
            organizationId,
            connectorId,
            authorizationServerUrl: metadata.authorizationServer.issuer,
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
          }),
      ),
    );

    if (insertedClient.length === 0) {
      const stored = yield* Result.await(
        safeDb((tx) =>
          tx.query.mcpOAuthClients.findFirst({
            where: {
              organizationId: { eq: organizationId },
              connectorId: { eq: connectorId },
              authorizationServerUrl: {
                eq: metadata.authorizationServer.issuer,
              },
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
