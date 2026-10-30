import { panic, Result } from "better-result";
import { eq, lt } from "drizzle-orm";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  MCP_RESPONSE_DISPOSITION,
  mcpOAuthState,
  mcpUserConnections,
} from "@/api/db/schema";
import { env } from "@/api/env";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { oauthCallbackFailureReason } from "@/api/lib/errors/oauth-callback-failure";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getCuratedMcpOAuthApproval } from "@/api/lib/mcp-connectors/catalog-metadata";
import {
  recordMcpAuthorizationReview,
  resolveMcpIssuerBinding,
} from "@/api/lib/mcp-upstream/authorization-review";
import { refreshCachedMcpToolsForConnection } from "@/api/lib/mcp-upstream/connections";
import {
  decryptMcpSecret,
  encryptMcpSecret,
} from "@/api/lib/mcp-upstream/crypto";
import {
  bindDiscoveredMetadata,
  discoverOAuthMetadataForApproval,
  exchangeAuthorizationCode,
  getOAuthEndpointOrigins,
  MCP_OAUTH_BINDING_FAILURE_CODE,
  observeAuthorizationResponseBinding,
  tokenExpiresAt,
  validateApprovedOAuthIssuer,
} from "@/api/lib/mcp-upstream/oauth";
import type {
  ApprovedMcpIssuerBinding,
  AuthorizationResponseBinding,
  AuthorizationResponseBindingVerdict,
  BoundOAuthMetadata,
  TokenResponse,
} from "@/api/lib/mcp-upstream/oauth";
import { mcpResourceMatchesConnector } from "@/api/lib/mcp-upstream/url-safety";
import { logger } from "@/api/lib/observability/logger";
import { requireRequestExceptionScope } from "@/api/lib/observability/request-context";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const STATE_TTL_MS = 10 * 60 * 1000;
const oauthStateCutoff = () =>
  new Date(Temporal.Now.instant().epochMilliseconds - STATE_TTL_MS);

const requestQuery = v.object({
  code: v.optional(v.string()),
  state: v.optional(v.string()),
  iss: v.optional(v.pipe(v.string(), v.maxLength(2048))),
});

const config = {
  contract: "patch",
  permissions: { integration: ["create"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "mcp_transport" },
  query: requestQuery,
} satisfies HandlerConfig;

type CallbackRedirectInput =
  { status: "connected"; slug: string } | { status: "error"; reason: string };

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

type OAuthCallbackFailureRedirectOptions = {
  error: unknown;
  organizationId: SafeId<"organization">;
  request: Request;
};

const redirectForOAuthCallbackFailure = ({
  error,
  organizationId,
  request,
}: OAuthCallbackFailureRedirectOptions) =>
  redirect({
    status: "error",
    reason: oauthCallbackFailureReason(error, {
      scope: requireRequestExceptionScope(request),
      operation: "mcp_oauth_callback",
      organizationId,
      request,
    }),
  });

const logAuthorizationResponseBindingObservation = ({
  binding,
  connectorId,
  verdict,
}: {
  binding: AuthorizationResponseBinding;
  connectorId: SafeId<"mcpConnector">;
  verdict: AuthorizationResponseBindingVerdict;
}) => {
  logger.info("mcp.oauth.binding_observed", {
    connectorId,
    issuerHost: URL.parse(binding.expectedIssuer)?.hostname ?? null,
    registrationMode: binding.registrationMode,
    issSupportedAdvertised: binding.issSupportedAdvertised,
    issPresent: verdict.issPresent,
    issMatches: verdict.issMatches,
    wouldRefuse: verdict.type === "would_refuse",
  });
};

type ValidatePendingOAuthMetadataOptions = {
  connectorUrl: string;
  resourceUrl: string;
  authorizationServerUrl: string;
  issuerBinding: ApprovedMcpIssuerBinding;
  permit: ThirdPartyOutboundPermit;
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
  issuerBinding,
  permit,
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
  const metadata = await discoverMetadata({ rawMcpUrl: connectorUrl, permit });
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
  const approval = validateApprovedOAuthIssuer(metadata.value, issuerBinding);
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
        code: "internal_error",
        message:
          "MCP authorization server metadata does not match the selected issuer",
      }),
    );
  }
  const boundMetadata = bindDiscoveredMetadata({
    connectorUrl,
    ...metadata.value,
    confirmedEndpointOrigins: issuerBinding.endpointOrigins,
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

// The pending state fields the callback helpers use. The callback redirects;
// it returns no stored row to the client.
type PendingOAuthConnection = {
  authorizationServerUrl: string;
  connectorId: SafeId<"mcpConnector">;
  organizationId: SafeId<"organization">;
  resourceUrl: string;
};

type AuthorizePendingConnectionOptions = {
  safeDb: SafeDb;
  userId: SafeId<"user">;
  pending: PendingOAuthConnection;
  connector: {
    url: string;
    oauthIssuer: string | null;
    oauthConfirmedEndpointOrigins: string[] | null;
  };
  permit: ThirdPartyOutboundPermit;
  discoverMetadata: typeof discoverOAuthMetadataForApproval;
  recordAuditEvent: AuditRecorder;
};

type PendingAuthorization =
  | { type: "bound"; metadata: BoundOAuthMetadata }
  | { type: "approval_required" }
  | { type: "failed"; error: HandlerError<400 | 409 | 502> | SafeDbError };

type RequestUnconfiguredIssuerReviewOptions = {
  connectorUrl: string;
  permit: ThirdPartyOutboundPermit;
  discoverMetadata: typeof discoverOAuthMetadataForApproval;
  requestReview: ValidatePendingOAuthMetadataOptions["requestReview"];
};

/**
 * A connector without an approved issuer completes no authorization: the
 * issuer it uses now is recorded for an administrator to review.
 */
const requestUnconfiguredIssuerReview = async ({
  connectorUrl,
  permit,
  discoverMetadata,
  requestReview,
}: RequestUnconfiguredIssuerReviewOptions): Promise<PendingAuthorization> => {
  const observed = await discoverMetadata({ rawMcpUrl: connectorUrl, permit });
  if (Result.isError(observed)) {
    return { type: "failed", error: observed.error };
  }
  const review = await requestReview(
    observed.value.authorizationServer.issuer,
    getOAuthEndpointOrigins(observed.value),
  );
  return Result.isError(review)
    ? { type: "failed", error: review.error }
    : { type: "approval_required" };
};

const authorizePendingConnection = async ({
  safeDb,
  userId,
  pending,
  connector,
  discoverMetadata,
  permit,
  recordAuditEvent,
}: AuthorizePendingConnectionOptions): Promise<PendingAuthorization> => {
  const authorizationReview = await safeDb((tx) =>
    tx.query.mcpConnectorAuthorizationReviews.findFirst({
      where: {
        organizationId: { eq: pending.organizationId },
        connectorId: { eq: pending.connectorId },
      },
      columns: {
        approvedIssuer: true,
        approvedEndpointOrigins: true,
        status: true,
      },
    }),
  );
  if (Result.isError(authorizationReview)) {
    return { type: "failed", error: authorizationReview.error };
  }
  if (authorizationReview.value?.status === "needs_reapproval") {
    return { type: "approval_required" };
  }

  const requestReview = async (
    observedIssuer: string,
    observedEndpointOrigins?: string[],
  ) =>
    await recordMcpAuthorizationReview({
      safeDb,
      organizationId: pending.organizationId,
      userId,
      connectorId: pending.connectorId,
      connection: { type: "mark" },
      recordAuditEvent,
      observedIssuer,
      ...(observedEndpointOrigins === undefined
        ? {}
        : { observedEndpointOrigins }),
    });

  const issuerBinding = resolveMcpIssuerBinding({
    curatedApproval: getCuratedMcpOAuthApproval(connector.url),
    connectorIssuer: connector.oauthIssuer,
    connectorConfirmedEndpointOrigins: connector.oauthConfirmedEndpointOrigins,
    reviewApprovedIssuer: authorizationReview.value?.approvedIssuer ?? null,
    reviewApprovedEndpointOrigins:
      authorizationReview.value?.approvedEndpointOrigins ?? null,
  });
  switch (issuerBinding.type) {
    case "unconfigured":
      return await requestUnconfiguredIssuerReview({
        connectorUrl: connector.url,
        permit,
        discoverMetadata,
        requestReview,
      });
    case "approved":
      break;
    default: {
      issuerBinding satisfies never;
      return panic("Unhandled MCP issuer binding");
    }
  }

  const boundMetadata = await validatePendingOAuthMetadata({
    connectorUrl: connector.url,
    resourceUrl: pending.resourceUrl,
    authorizationServerUrl: pending.authorizationServerUrl,
    issuerBinding,
    permit,
    discoverMetadata,
    requestReview,
  });
  return Result.isError(boundMetadata)
    ? { type: "failed", error: boundMetadata.error }
    : { type: "bound", metadata: boundMetadata.value };
};

type SaveOAuthConnectionOptions = {
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
  pending: PendingOAuthConnection;
  state: string;
  connectorSlug: string;
  userId: SafeId<"user">;
  token: TokenResponse;
};

const saveOAuthConnection = async ({
  safeDb,
  recordAuditEvent,
  pending,
  state,
  connectorSlug,
  userId,
  token,
}: SaveOAuthConnectionOptions) => {
  const encryptedAccess = await encryptMcpSecret({
    connectorId: pending.connectorId,
    organizationId: pending.organizationId,
    purpose: "mcp_access_token",
    secret: token.access_token,
    userId,
  });
  const encryptedRefresh = token.refresh_token
    ? await encryptMcpSecret({
        connectorId: pending.connectorId,
        organizationId: pending.organizationId,
        purpose: "mcp_refresh_token",
        secret: token.refresh_token,
        userId,
      })
    : null;

  // The safeDb transaction is the only boundary; a failure rolls back every write.
  return await safeDb(async (tx) => {
    const consumed = await tx
      .delete(mcpOAuthState)
      .where(eq(mcpOAuthState.state, state))
      .returning({ state: mcpOAuthState.state });
    if (consumed.length !== 1) {
      return { type: "superseded" as const };
    }
    await tx
      .delete(mcpOAuthState)
      .where(
        lt(
          mcpOAuthState.createdAt,
          new Date(Temporal.Now.instant().epochMilliseconds - STATE_TTL_MS),
        ),
      );
    const rows = await tx
      .insert(mcpUserConnections)
      .values({
        organizationId: pending.organizationId,
        connectorId: pending.connectorId,
        userId,
        accessTokenEncrypted: encryptedAccess.ciphertext,
        accessTokenIv: encryptedAccess.iv,
        refreshTokenEncrypted: encryptedRefresh?.ciphertext ?? null,
        refreshTokenIv: encryptedRefresh?.iv ?? null,
        tokenType: token.token_type ?? "Bearer",
        scope: token.scope ?? null,
        resourceUrl: pending.resourceUrl,
        authorizationServerUrl: pending.authorizationServerUrl,
        expiresAt: tokenExpiresAt(token),
        status: "connected",
        responseDisposition: MCP_RESPONSE_DISPOSITION.normal,
        responseTargetUrl: null,
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
          tokenType: token.token_type ?? "Bearer",
          scope: token.scope ?? null,
          resourceUrl: pending.resourceUrl,
          authorizationServerUrl: pending.authorizationServerUrl,
          expiresAt: tokenExpiresAt(token),
          refreshLeaseExpiresAt: null,
          refreshRetryAfter: null,
          cachedTools: null,
          cachedToolsRefreshedAt: null,
          status: "connected",
          responseDisposition: MCP_RESPONSE_DISPOSITION.normal,
          responseTargetUrl: null,
          enabled: true,
          updatedAt: new Date(),
        },
      })
      .returning({ id: mcpUserConnections.id });
    const row = rows.at(0);
    if (row) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
        resourceId: row.id,
        workspaceId: null,
        metadata: {
          connectorId: pending.connectorId,
          connectorSlug,
          connectionUserId: userId,
          credential: "oauth",
        },
      });
    }
    return { type: "saved" as const, rows };
  });
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

        const cutoff = oauthStateCutoff();

        // A DB failure here is a Result.err, not a thrown exception: `yield*` on
        // an Err closes this generator via `.return()`, which skips `catch`
        // below (only `finally` would run). Await and branch explicitly instead
        // of `yield*` so every failure — DB or thrown — still redirects.
        const redirectForFailure = (error: unknown) =>
          redirectForOAuthCallbackFailure({
            error,
            organizationId: session.activeOrganizationId,
            request,
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
          const permit = grantThirdPartyOutboundPermit();

          const authorization = await authorizePendingConnection({
            safeDb,
            userId: user.id,
            pending: row,
            connector: row.connector,
            discoverMetadata,
            recordAuditEvent,
            permit,
          });
          switch (authorization.type) {
            case "approval_required":
              return Result.ok(
                redirect({ status: "error", reason: "approval-required" }),
              );
            case "failed":
              return Result.ok(redirectForFailure(authorization.error));
            case "bound":
              break;
            default: {
              authorization satisfies never;
              return panic(
                "Unhandled MCP OAuth callback authorization outcome",
              );
            }
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

          const legacyBinding = {
            type: "unbound",
            expectedIssuer: row.authorizationServerUrl,
            reason: "state_without_binding",
            registrationMode: "unknown",
            issSupportedAdvertised: false,
          } satisfies AuthorizationResponseBinding;
          const binding = row.authorizationResponseBinding ?? legacyBinding;
          const token = await observeAuthorizationResponseBinding({
            binding,
            response: { issuer: input.iss },
            observe: (verdict) =>
              logAuthorizationResponseBindingObservation({
                binding,
                connectorId: row.connectorId,
                verdict,
              }),
            exchange: async () =>
              exchangeAuthorizationCode({
                metadata: authorization.metadata,
                permit,
                responseIssuer: input.iss,
                clientId: client.clientId,
                clientSecret,
                code,
                codeVerifier: row.codeVerifier,
                redirectUri: row.redirectUri,
              }),
          });

          if (Result.isError(token)) {
            return Result.ok(
              redirect({ status: "error", reason: "token-exchange" }),
            );
          }

          const savedResult = await saveOAuthConnection({
            safeDb,
            recordAuditEvent,
            pending: row,
            state,
            connectorSlug,
            userId: brandPersistedUserId(row.userId),
            token: token.value,
          });
          if (Result.isError(savedResult)) {
            return Result.ok(redirectForFailure(savedResult.error));
          }
          const saved = savedResult.value;
          if (saved.type === "superseded") {
            return Result.ok(
              redirect({ status: "error", reason: "expired-state" }),
            );
          }

          const connection = saved.rows.at(0);
          if (connection) {
            await refreshCachedMcpToolsForConnection({
              connectionId: connection.id,
              organizationId: session.activeOrganizationId,
              permit,
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
