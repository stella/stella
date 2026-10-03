import { Result } from "better-result";
import { eq, lt } from "drizzle-orm";
import { t } from "elysia";

import { Temporal } from "@stll/time";

import type { SafeDbError } from "@/api/db/safe-db";
import { mcpOAuthState, mcpUserConnections } from "@/api/db/schema";
import { env } from "@/api/env";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { oauthCallbackFailureReason } from "@/api/lib/errors/oauth-callback-failure";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getCuratedMcpOAuthApproval } from "@/api/lib/mcp-connectors/catalog-metadata";
import { recordMcpAuthorizationReview } from "@/api/lib/mcp-upstream/authorization-review";
import { refreshCachedMcpToolsForConnection } from "@/api/lib/mcp-upstream/connections";
import {
  decryptMcpSecret,
  encryptMcpSecret,
} from "@/api/lib/mcp-upstream/crypto";
import {
  MCP_OAUTH_BINDING_FAILURE_CODE,
  discoverOAuthMetadataForApproval,
  bindDiscoveredMetadata,
  getOAuthEndpointOrigins,
  validateApprovedOAuthIssuer,
  exchangeAuthorizationCode,
  tokenExpiresAt,
} from "@/api/lib/mcp-upstream/oauth";
import type { BoundOAuthMetadata } from "@/api/lib/mcp-upstream/oauth";
import { mcpResourceMatchesConnector } from "@/api/lib/mcp-upstream/url-safety";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const STATE_TTL_MS = 10 * 60 * 1000;

const requestQuery = t.Object({
  code: t.Optional(t.String()),
  state: t.Optional(t.String()),
  iss: t.Optional(t.String()),
});

const config = {
  permissions: { integration: ["create"] },
  mcp: { type: "internal", reason: "mcp_transport" },
  query: requestQuery,
} satisfies HandlerConfig;

type CallbackRedirectInput =
  | { status: "connected"; slug: string }
  | { status: "error"; reason: string };

// The popup lands on a SPA route that does the postMessage + close.
// Returning HTML with an inline <script> from api.stll.app is blocked
// by the API's CSP (`script-src 'self' 'unsafe-eval'`) and its
// `Cross-Origin-Opener-Policy: same-origin` would also detach
// `window.opener`, so the SPA host is the only place the terminal
// page can run.
export const buildCallbackRedirectUrl = (
  frontendUrl: string,
  input: CallbackRedirectInput,
): string => {
  const url = new URL("/mcp/oauth-callback", frontendUrl);
  url.searchParams.set("status", input.status);
  if (input.status === "connected") {
    url.searchParams.set("slug", input.slug);
  } else {
    url.searchParams.set("reason", input.reason);
  }
  return url.toString();
};

const redirect = (input: CallbackRedirectInput) =>
  new Response(null, {
    status: 302,
    headers: { Location: buildCallbackRedirectUrl(env.FRONTEND_URL, input) },
  });

type ValidatePendingOAuthMetadataOptions = {
  connectorUrl: string;
  resourceUrl: string;
  authorizationServerUrl: string;
  approvedIssuer: string | null;
  confirmedEndpointOrigins: readonly string[];
  discoverMetadata: typeof discoverOAuthMetadataForApproval;
  requestReview: (
    observedIssuer: string,
    observedEndpointOrigins?: string[],
  ) => ReturnType<typeof recordMcpAuthorizationReview>;
};

type PendingOAuthMetadataResult = Result<
  BoundOAuthMetadata,
  HandlerError<400 | 409 | 502> | SafeDbError
>;

const validatePendingOAuthMetadata = async ({
  connectorUrl,
  resourceUrl,
  authorizationServerUrl,
  approvedIssuer,
  confirmedEndpointOrigins,
  discoverMetadata,
  requestReview,
}: ValidatePendingOAuthMetadataOptions): Promise<PendingOAuthMetadataResult> => {
  if (!mcpResourceMatchesConnector({ resourceUrl, connectorUrl })) {
    const review = await requestReview(authorizationServerUrl);
    if (Result.isError(review)) {
      return Result.err(review.error);
    }
    return Result.err(
      new HandlerError({
        status: 502,
        code: MCP_OAUTH_BINDING_FAILURE_CODE,
        message: "MCP resource metadata does not match the connector URL",
      }),
    );
  }
  const metadata = await discoverMetadata(connectorUrl);
  if (Result.isError(metadata)) {
    if (metadata.error.code === MCP_OAUTH_BINDING_FAILURE_CODE) {
      const review = await requestReview(authorizationServerUrl);
      if (Result.isError(review)) {
        return Result.err(review.error);
      }
    }
    return Result.err(metadata.error);
  }
  if (metadata.value.protectedResource.resource !== resourceUrl) {
    return Result.err(
      new HandlerError({
        status: 502,
        code: MCP_OAUTH_BINDING_FAILURE_CODE,
        message: "MCP resource metadata does not match the pending connection",
      }),
    );
  }
  const approval = validateApprovedOAuthIssuer(metadata.value, approvedIssuer);
  if (Result.isError(approval)) {
    const review = await requestReview(
      metadata.value.authorizationServer.issuer,
      getOAuthEndpointOrigins(metadata.value),
    );
    return Result.isError(review)
      ? Result.err(review.error)
      : Result.err(approval.error);
  }
  if (metadata.value.authorizationServer.issuer !== authorizationServerUrl) {
    return Result.err(
      new HandlerError({
        status: 502,
        message:
          "MCP authorization server metadata does not match the selected issuer",
      }),
    );
  }
  const boundMetadata = bindDiscoveredMetadata({
    connectorUrl,
    ...metadata.value,
    confirmedEndpointOrigins,
  });
  if (Result.isError(boundMetadata)) {
    const review = await requestReview(
      metadata.value.authorizationServer.issuer,
      getOAuthEndpointOrigins(metadata.value),
    );
    return Result.isError(review)
      ? Result.err(review.error)
      : Result.err(boundMetadata.error);
  }
  return boundMetadata;
};

export const createMcpOAuthCallbackHandler = (
  discoverMetadata: typeof discoverOAuthMetadataForApproval,
) =>
  createSafeRootHandler(
    config,
    async function* ({
      query: input,
      request,
      safeDb,
      session,
      user,
      recordAuditEvent,
    }) {
      const run = async (): Promise<Result<Response, never>> => {
        if (!input.code || !input.state) {
          return Result.ok(
            redirect({ status: "error", reason: "missing-code" }),
          );
        }
        const code = input.code;
        const state = input.state;

        const cutoff = new Date(
          Temporal.Now.instant().epochMilliseconds - STATE_TTL_MS,
        );

        // A DB failure here is a Result.err, not a thrown exception: `yield*` on
        // an Err closes this generator via `.return()`, which skips `catch`
        // below (only `finally` would run). Await and branch explicitly instead
        // of `yield*` so every failure — DB or thrown — still redirects.
        const redirectForFailure = (error: unknown) =>
          redirect({
            status: "error",
            reason: oauthCallbackFailureReason(error, {
              operation: "mcp_oauth_callback",
              organizationId: session.activeOrganizationId,
              request,
            }),
          });

        try {
          const rowResult = await safeDb((tx) =>
            tx.query.mcpOAuthState.findFirst({
              where: { state: { eq: state } },
              with: {
                connector: {
                  columns: {
                    id: true,
                    slug: true,
                    url: true,
                    oauthIssuer: true,
                    oauthConfirmedEndpointOrigins: true,
                  },
                },
              },
            }),
          );
          if (Result.isError(rowResult)) {
            return Result.ok(redirectForFailure(rowResult.error));
          }
          const row = rowResult.value;

          if (!row || row.createdAt < cutoff) {
            return Result.ok(
              redirect({ status: "error", reason: "expired-state" }),
            );
          }
          if (!row.connector) {
            return Result.ok(
              redirect({ status: "error", reason: "missing-connector" }),
            );
          }
          if (
            row.organizationId !== session.activeOrganizationId ||
            row.userId !== user.id
          ) {
            return Result.ok(
              redirect({ status: "error", reason: "user-mismatch" }),
            );
          }
          const connectorSlug = row.connector.slug;

          const authorizationReview = await safeDb((tx) =>
            tx.query.mcpConnectorAuthorizationReviews.findFirst({
              where: {
                organizationId: { eq: session.activeOrganizationId },
                connectorId: { eq: row.connectorId },
              },
              columns: {
                approvedIssuer: true,
                approvedEndpointOrigins: true,
                status: true,
              },
            }),
          );
          if (Result.isError(authorizationReview)) {
            return Result.ok(redirectForFailure(authorizationReview.error));
          }
          if (authorizationReview.value?.status === "needs_reapproval") {
            return Result.ok(
              redirect({ status: "error", reason: "approval-required" }),
            );
          }

          const requestReview = async (
            observedIssuer: string,
            observedEndpointOrigins?: string[],
          ) =>
            await recordMcpAuthorizationReview({
              safeDb,
              organizationId: session.activeOrganizationId,
              userId: user.id,
              connectorId: row.connectorId,
              recordAuditEvent,
              observedIssuer,
              ...(observedEndpointOrigins === undefined
                ? {}
                : { observedEndpointOrigins }),
            });

          const boundMetadata = await validatePendingOAuthMetadata({
            connectorUrl: row.connector.url,
            resourceUrl: row.resourceUrl,
            authorizationServerUrl: row.authorizationServerUrl,
            approvedIssuer:
              authorizationReview.value?.approvedIssuer ??
              row.connector.oauthIssuer,
            confirmedEndpointOrigins:
              authorizationReview.value?.approvedEndpointOrigins ??
              row.connector.oauthConfirmedEndpointOrigins ??
              getCuratedMcpOAuthApproval(row.connector.url)?.endpointOrigins ??
              [],
            discoverMetadata,
            requestReview,
          });
          if (Result.isError(boundMetadata)) {
            return Result.ok(redirectForFailure(boundMetadata.error));
          }

          const clientResult = await safeDb((tx) =>
            tx.query.mcpOAuthClients.findFirst({
              where: {
                organizationId: { eq: row.organizationId },
                connectorId: { eq: row.connectorId },
                authorizationServerUrl: { eq: row.authorizationServerUrl },
              },
              columns: {
                clientId: true,
                clientSecretEncrypted: true,
                clientSecretIv: true,
              },
            }),
          );
          if (Result.isError(clientResult)) {
            return Result.ok(redirectForFailure(clientResult.error));
          }
          const client = clientResult.value;

          if (!client) {
            return Result.ok(
              redirect({ status: "error", reason: "missing-client" }),
            );
          }

          const clientSecret =
            client.clientSecretEncrypted && client.clientSecretIv
              ? await decryptMcpSecret({
                  ciphertext: client.clientSecretEncrypted,
                  connectorId: row.connectorId,
                  iv: client.clientSecretIv,
                  organizationId: row.organizationId,
                  purpose: "mcp_client_secret",
                })
              : null;

          const token = await exchangeAuthorizationCode({
            metadata: boundMetadata.value,
            responseIssuer: input.iss,
            clientId: client.clientId,
            clientSecret,
            code,
            codeVerifier: row.codeVerifier,
            redirectUri: row.redirectUri,
          });

          if (Result.isError(token)) {
            return Result.ok(
              redirect({ status: "error", reason: "token-exchange" }),
            );
          }

          const rowUserId = brandPersistedUserId(row.userId);
          const encryptedAccess = await encryptMcpSecret({
            connectorId: row.connectorId,
            organizationId: row.organizationId,
            purpose: "mcp_access_token",
            secret: token.value.access_token,
            userId: rowUserId,
          });
          const encryptedRefresh = token.value.refresh_token
            ? await encryptMcpSecret({
                connectorId: row.connectorId,
                organizationId: row.organizationId,
                purpose: "mcp_refresh_token",
                secret: token.value.refresh_token,
                userId: rowUserId,
              })
            : null;

          const savedResult = await safeDb(async (tx) =>
            tx.transaction(async (innerTx) => {
              await innerTx
                .delete(mcpOAuthState)
                .where(eq(mcpOAuthState.state, state));
              await innerTx
                .delete(mcpOAuthState)
                .where(lt(mcpOAuthState.createdAt, cutoff));
              const rows = await innerTx
                .insert(mcpUserConnections)
                .values({
                  organizationId: row.organizationId,
                  connectorId: row.connectorId,
                  userId: rowUserId,
                  accessTokenEncrypted: encryptedAccess.ciphertext,
                  accessTokenIv: encryptedAccess.iv,
                  refreshTokenEncrypted: encryptedRefresh?.ciphertext ?? null,
                  refreshTokenIv: encryptedRefresh?.iv ?? null,
                  tokenType: token.value.token_type ?? "Bearer",
                  scope: token.value.scope ?? null,
                  resourceUrl: row.resourceUrl,
                  authorizationServerUrl: row.authorizationServerUrl,
                  expiresAt: tokenExpiresAt(token.value),
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
                    accessTokenEncrypted: encryptedAccess.ciphertext,
                    accessTokenIv: encryptedAccess.iv,
                    refreshTokenEncrypted: encryptedRefresh?.ciphertext ?? null,
                    refreshTokenIv: encryptedRefresh?.iv ?? null,
                    staticTokenEncrypted: null,
                    staticTokenIv: null,
                    tokenType: token.value.token_type ?? "Bearer",
                    scope: token.value.scope ?? null,
                    resourceUrl: row.resourceUrl,
                    authorizationServerUrl: row.authorizationServerUrl,
                    expiresAt: tokenExpiresAt(token.value),
                    refreshLeaseExpiresAt: null,
                    refreshRetryAfter: null,
                    cachedTools: null,
                    cachedToolsRefreshedAt: null,
                    status: "connected",
                    enabled: true,
                    updatedAt: new Date(),
                  },
                })
                .returning({ id: mcpUserConnections.id });
              await recordAuditEvent(innerTx, {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
                resourceId: row.connectorId,
                workspaceId: null,
                metadata: {
                  connectorId: row.connectorId,
                  connectorSlug,
                  connectionUserId: rowUserId,
                  operation: "mcp_oauth_connect",
                },
              });
              return rows;
            }),
          );
          if (Result.isError(savedResult)) {
            return Result.ok(redirectForFailure(savedResult.error));
          }
          const saved = savedResult.value;

          const connection = saved.at(0);
          if (connection) {
            await refreshCachedMcpToolsForConnection({
              connectionId: connection.id,
              organizationId: session.activeOrganizationId,
              safeDb,
              userId: user.id,
            });
          }

          return Result.ok(
            redirect({ status: "connected", slug: connectorSlug }),
          );
        } catch (error) {
          return Result.ok(redirectForFailure(error));
        }
      };

      // `run` always resolves `Result.ok(...)` (every failure branch above
      // redirects instead of erroring), so this is a real `yield*` outside any
      // try — it exists to unwrap `run`'s result, not to propagate a DB Err.
      return Result.ok(yield* Result.await(run()));
    },
  );

export default createMcpOAuthCallbackHandler(discoverOAuthMetadataForApproval);
