import { panic, Result } from "better-result";
import { eq, lt } from "drizzle-orm";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { sharepointConnections, sharepointOAuthState } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  capabilityEnabled,
  consentedScopes,
  delegatedReadScopes,
  grantedCapabilities,
  LEGACY_FILE_CAPABILITIES,
  scopeSet,
} from "@/api/handlers/sharepoint/capabilities";
import { encryptSharepointSecret } from "@/api/handlers/sharepoint/crypto";
import { fetchAccountLabel } from "@/api/handlers/sharepoint/graph-client";
import {
  exchangeAuthorizationCode,
  getSharepointOAuthConfig,
  tokenExpiresAt,
} from "@/api/handlers/sharepoint/graph-oauth";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { oauthCallbackFailureReason } from "@/api/lib/errors/oauth-callback-failure";
import { requireRequestExceptionScope } from "@/api/lib/observability/request-context";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { readLockedSharepointPolicy } from "@/api/lib/sharepoint-policy-lock";

const STATE_TTL_MS = 10 * 60 * 1000;

const requestQuery = v.object({
  code: v.optional(v.string()),
  state: v.optional(v.string()),
  error: v.optional(v.string()),
});

const config = {
  contract: "patch",
  permissions: { integration: ["create"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  query: requestQuery,
} satisfies HandlerConfig;

type CallbackRedirectInput =
  { status: "connected" } | { status: "error"; reason: string };

const buildCallbackRedirectUrl = (
  frontendUrl: string,
  input: CallbackRedirectInput,
): string => {
  const url = new URL("/sharepoint/oauth-callback", frontendUrl);
  url.searchParams.set("status", input.status);
  if (input.status === "error") {
    url.searchParams.set("reason", input.reason);
  }
  return url.toString();
};

const redirect = (input: CallbackRedirectInput) =>
  new Response(null, {
    status: 302,
    headers: { Location: buildCallbackRedirectUrl(env.FRONTEND_URL, input) },
  });

// Terminal leg of the delegated Graph flow: validate the state we minted,
// exchange the code for the user's own tokens, and persist them encrypted.
// All failure branches redirect to the SPA with a reason rather than leaking
// an error body.
export type SharepointOAuthCallbackDependencies = {
  deploymentEnabled: typeof isDeploymentFeatureEnabled;
  getSharepointOAuthConfig?: typeof getSharepointOAuthConfig;
  exchangeAuthorizationCode?: typeof exchangeAuthorizationCode;
  fetchAccountLabel?: typeof fetchAccountLabel;
};

const defaultSharepointOAuthCallbackDependencies = {
  deploymentEnabled: isDeploymentFeatureEnabled,
} satisfies SharepointOAuthCallbackDependencies;

export const createSharepointOAuthCallback = (
  dependencies: SharepointOAuthCallbackDependencies = defaultSharepointOAuthCallbackDependencies,
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
        if (!dependencies.deploymentEnabled("FEATURE_SHAREPOINT")) {
          return Result.ok(
            redirect({ status: "error", reason: "not-enabled" }),
          );
        }

        if (input.error) {
          return Result.ok(
            redirect({ status: "error", reason: "consent-denied" }),
          );
        }
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
        // of `yield*` so every failure — DB or thrown — still redirects rather
        // than leaking a raw error body.
        const redirectForFailure = (error: unknown) =>
          redirect({
            status: "error",
            reason: oauthCallbackFailureReason(error, {
              scope: requireRequestExceptionScope(request),
              operation: "sharepoint_oauth_callback",
              organizationId: session.activeOrganizationId,
              request,
            }),
          });

        try {
          const stateRowsResult = await safeDb((tx) =>
            tx
              .select({
                organizationId: sharepointOAuthState.organizationId,
                userId: sharepointOAuthState.userId,
                codeVerifier: sharepointOAuthState.codeVerifier,
                redirectUri: sharepointOAuthState.redirectUri,
                requestedScope: sharepointOAuthState.requestedScope,
                createdAt: sharepointOAuthState.createdAt,
              })
              .from(sharepointOAuthState)
              .where(eq(sharepointOAuthState.state, state))
              .limit(1),
          );
          if (Result.isError(stateRowsResult)) {
            return Result.ok(redirectForFailure(stateRowsResult.error));
          }
          const row = stateRowsResult.value.at(0);

          if (!row || row.createdAt < cutoff) {
            return Result.ok(
              redirect({ status: "error", reason: "expired-state" }),
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

          const oauthConfig = (
            dependencies.getSharepointOAuthConfig ?? getSharepointOAuthConfig
          )();
          if (Result.isError(oauthConfig)) {
            return Result.ok(
              redirect({ status: "error", reason: "not-configured" }),
            );
          }

          // Pending states created by older tasks contain no scope column.
          // Their issued consent request was file-only, never calendar.
          const requestedScope =
            row.requestedScope ?? delegatedReadScopes(LEGACY_FILE_CAPABILITIES);

          const permit = grantThirdPartyOutboundPermit();
          const token = await (
            dependencies.exchangeAuthorizationCode ?? exchangeAuthorizationCode
          )({
            clientId: oauthConfig.value.clientId,
            clientSecret: oauthConfig.value.clientSecret,
            tenantId: oauthConfig.value.tenantId,
            code,
            codeVerifier: row.codeVerifier,
            permit,
            redirectUri: row.redirectUri,
            scope: requestedScope,
            signal: request.signal,
          });
          if (Result.isError(token)) {
            return Result.ok(
              redirect({ status: "error", reason: "token-exchange" }),
            );
          }

          const rowUserId = brandPersistedUserId(row.userId);
          const accountLabelResult = await (
            dependencies.fetchAccountLabel ?? fetchAccountLabel
          )({
            accessToken: token.value.access_token,
            permit,
            signal: request.signal,
          });
          // A display label is optional; its typed lookup failure is already
          // observed, and it does not invalidate the granted token.
          const accountLabel = Result.isOk(accountLabelResult)
            ? accountLabelResult.value
            : null;

          const encryptedAccess = await encryptSharepointSecret({
            purpose: "sharepoint_access_token",
            secret: token.value.access_token,
            organizationId: row.organizationId,
            userId: rowUserId,
          });
          const encryptedRefresh = token.value.refresh_token
            ? await encryptSharepointSecret({
                purpose: "sharepoint_refresh_token",
                secret: token.value.refresh_token,
                organizationId: row.organizationId,
                userId: rowUserId,
              })
            : null;

          const connectResult = await safeDb(async (tx) =>
            withAggregateSavepoint(tx, async (innerTx) => {
              // Check the requested capabilities under the settings row lock:
              // an admin may revoke either grant during the Graph round trips.
              const policy = await readLockedSharepointPolicy({
                tx: innerTx,
                organizationId: row.organizationId,
                mode: "update",
              });
              if (!policy) {
                return { status: "not-enabled" as const };
              }

              // Authoritative on the state token: a concurrent callback for the
              // same state (replay, or a double-fired redirect) deletes zero
              // rows here and must not also persist a connection.
              const deletedState = await innerTx
                .delete(sharepointOAuthState)
                .where(eq(sharepointOAuthState.state, state))
                .returning({ state: sharepointOAuthState.state });
              await innerTx
                .delete(sharepointOAuthState)
                .where(lt(sharepointOAuthState.createdAt, cutoff));
              if (deletedState.length === 0) {
                return { status: "state-consumed" as const };
              }

              const requestedCapabilities = grantedCapabilities(requestedScope);
              if (
                requestedCapabilities.length === 0 ||
                requestedCapabilities.some(
                  (capability) => !capabilityEnabled(policy, capability),
                )
              ) {
                return { status: "not-enabled" as const };
              }
              const scope = consentedScopes({
                providerScope: token.value.scope,
                requestedScope,
                policy,
              });
              const granted = grantedCapabilities(scope);
              if (
                requestedCapabilities.some(
                  (capability) => !granted.includes(capability),
                )
              ) {
                return { status: "capability-not-granted" as const };
              }

              await innerTx
                .insert(sharepointConnections)
                .values({
                  organizationId: row.organizationId,
                  userId: rowUserId,
                  accessTokenEncrypted: encryptedAccess.ciphertext,
                  accessTokenIv: encryptedAccess.iv,
                  refreshTokenEncrypted: encryptedRefresh?.ciphertext ?? null,
                  refreshTokenIv: encryptedRefresh?.iv ?? null,
                  tokenType: token.value.token_type ?? "Bearer",
                  scope,
                  accountLabel,
                  expiresAt: tokenExpiresAt(token.value),
                  status: "connected",
                })
                .onConflictDoUpdate({
                  target: [
                    sharepointConnections.organizationId,
                    sharepointConnections.userId,
                  ],
                  set: {
                    accessTokenEncrypted: encryptedAccess.ciphertext,
                    accessTokenIv: encryptedAccess.iv,
                    refreshTokenEncrypted: encryptedRefresh?.ciphertext ?? null,
                    refreshTokenIv: encryptedRefresh?.iv ?? null,
                    tokenType: token.value.token_type ?? "Bearer",
                    scope,
                    accountLabel,
                    expiresAt: tokenExpiresAt(token.value),
                    status: "connected",
                    updatedAt: new Date(),
                  },
                });
              await recordAuditEvent(innerTx, {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
                resourceId: row.organizationId,
                workspaceId: null,
                metadata: {
                  connectionUserId: rowUserId,
                  operation: "sharepoint_oauth_connect",
                  grantedScopes: scopeSet(scope),
                  grantedCapabilities: granted,
                },
              });
              return { status: "connected" as const };
            }),
          );
          if (Result.isError(connectResult)) {
            return Result.ok(redirectForFailure(connectResult.error));
          }

          switch (connectResult.value.status) {
            case "not-enabled": {
              return Result.ok(
                redirect({ status: "error", reason: "not-enabled" }),
              );
            }
            case "state-consumed": {
              return Result.ok(
                redirect({ status: "error", reason: "expired-state" }),
              );
            }
            case "capability-not-granted": {
              return Result.ok(
                redirect({ status: "error", reason: "capability-not-granted" }),
              );
            }
            case "connected": {
              return Result.ok(redirect({ status: "connected" }));
            }
            default: {
              connectResult.value satisfies never;
              return panic(`Unhandled value: ${String(connectResult.value)}`);
            }
          }
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

const sharepointOAuthCallback = createSharepointOAuthCallback();

export default sharepointOAuthCallback;
