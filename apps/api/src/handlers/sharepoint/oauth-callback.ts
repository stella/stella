import { Result } from "better-result";
import { eq, lt } from "drizzle-orm";
import { t } from "elysia";

import {
  organizationSettings,
  sharepointConnections,
  sharepointOAuthState,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { encryptSharepointSecret } from "@/api/handlers/sharepoint/crypto";
import { assertSharepointConnectionEnabled } from "@/api/handlers/sharepoint/enablement";
import { fetchAccountLabel } from "@/api/handlers/sharepoint/graph-client";
import {
  exchangeAuthorizationCode,
  getSharepointOAuthConfig,
  tokenExpiresAt,
} from "@/api/handlers/sharepoint/graph-oauth";
import { captureError } from "@/api/lib/analytics/capture";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const STATE_TTL_MS = 10 * 60 * 1000;

const requestQuery = t.Object({
  code: t.Optional(t.String()),
  state: t.Optional(t.String()),
  error: t.Optional(t.String()),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "provider_secret" },
  query: requestQuery,
} satisfies HandlerConfig;

type CallbackRedirectInput =
  | { status: "connected" }
  | { status: "error"; reason: string };

export const buildCallbackRedirectUrl = (
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
  assertSharepointConnectionEnabled: typeof assertSharepointConnectionEnabled;
};

const defaultSharepointOAuthCallbackDependencies = {
  assertSharepointConnectionEnabled,
} satisfies SharepointOAuthCallbackDependencies;

export const createSharepointOAuthCallback = (
  dependencies: SharepointOAuthCallbackDependencies = defaultSharepointOAuthCallbackDependencies,
) =>
  createSafeRootHandler(
    config,
    async function* ({
      query: input,
      safeDb,
      session,
      user,
      recordAuditEvent,
    }) {
      const run = async (): Promise<Result<Response, never>> => {
        const gate = await dependencies.assertSharepointConnectionEnabled({
          organizationId: session.activeOrganizationId,
          safeDb,
        });
        if (Result.isError(gate)) {
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
        const cutoff = new Date(Date.now() - STATE_TTL_MS);

        // A DB failure here is a Result.err, not a thrown exception: `yield*` on
        // an Err closes this generator via `.return()`, which skips `catch`
        // below (only `finally` would run). Await and branch explicitly instead
        // of `yield*` so every failure — DB or thrown — still redirects rather
        // than leaking a raw error body.
        const redirectForFailure = (error: unknown) => {
          if (HandlerError.is(error)) {
            return redirect({ status: "error", reason: "invalid-secret" });
          }
          captureError(error, {
            operation: "sharepoint_oauth_callback",
            organizationId: session.activeOrganizationId,
            userId: user.id,
          });
          return redirect({ status: "error", reason: "unexpected" });
        };

        try {
          const stateRowsResult = await safeDb((tx) =>
            tx
              .select({
                organizationId: sharepointOAuthState.organizationId,
                userId: sharepointOAuthState.userId,
                codeVerifier: sharepointOAuthState.codeVerifier,
                redirectUri: sharepointOAuthState.redirectUri,
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

          const oauthConfig = getSharepointOAuthConfig();
          if (Result.isError(oauthConfig)) {
            return Result.ok(
              redirect({ status: "error", reason: "not-configured" }),
            );
          }

          const token = await exchangeAuthorizationCode({
            clientId: oauthConfig.value.clientId,
            clientSecret: oauthConfig.value.clientSecret,
            tenantId: oauthConfig.value.tenantId,
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
          const accountLabel = await fetchAccountLabel(
            token.value.access_token,
          );

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
            tx.transaction(async (innerTx) => {
              // Re-check enablement under the row lock: the Graph round trips
              // above can take long enough for an admin to turn the connection
              // off mid-flow, and the check at the top of this handler ran
              // before any of that work started.
              const settingsRows = await innerTx
                .select({
                  sharepointConnectionEnabled:
                    organizationSettings.sharepointConnectionEnabled,
                })
                .from(organizationSettings)
                .where(
                  eq(organizationSettings.organizationId, row.organizationId),
                )
                .for("update");
              if (!settingsRows.at(0)?.sharepointConnectionEnabled) {
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
                  scope: token.value.scope ?? null,
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
                    scope: token.value.scope ?? null,
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
            case "connected": {
              return Result.ok(redirect({ status: "connected" }));
            }
            default: {
              const exhaustive: never = connectResult.value;
              return exhaustive;
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
