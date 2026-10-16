import { panic, Result } from "better-result";
import { eq, lt } from "drizzle-orm";
import { t } from "elysia";

import { Temporal } from "@stll/time";

import {
  organizationSettings,
  microsoft365Connections,
  microsoft365OAuthState,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { encryptMicrosoft365Secret } from "@/api/handlers/microsoft365/crypto";
import { assertMicrosoft365ConnectionEnabled } from "@/api/handlers/microsoft365/enablement";
import { fetchAccountLabel } from "@/api/handlers/microsoft365/graph-client";
import {
  exchangeAuthorizationCode,
  getMicrosoft365OAuthConfig,
  tokenExpiresAt,
} from "@/api/handlers/microsoft365/graph-oauth";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { oauthCallbackFailureReason } from "@/api/lib/errors/oauth-callback-failure";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const STATE_TTL_MS = 10 * 60 * 1000;

const requestQuery = t.Object({
  code: t.Optional(t.String({ maxLength: 4096 })),
  state: t.Optional(t.String({ maxLength: 128 })),
  error: t.Optional(t.String({ maxLength: 256 })),
});

const config = {
  contract: "patch",
  permissions: { integration: ["create"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  query: requestQuery,
} satisfies HandlerConfig;

type CallbackRedirectInput =
  | { status: "connected" }
  | { status: "error"; reason: string };

const buildCallbackRedirectUrl = (
  frontendUrl: string,
  input: CallbackRedirectInput,
): string => {
  const url = new URL("/settings/account/connections", frontendUrl);
  url.searchParams.set("microsoft365Status", input.status);
  if (input.status === "error") {
    url.searchParams.set("microsoft365Reason", input.reason);
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
export type Microsoft365OAuthCallbackDependencies = {
  assertMicrosoft365ConnectionEnabled: typeof assertMicrosoft365ConnectionEnabled;
  exchangeAuthorizationCode: typeof exchangeAuthorizationCode;
  getMicrosoft365OAuthConfig: typeof getMicrosoft365OAuthConfig;
  fetchAccountLabel: typeof fetchAccountLabel;
};

const defaultMicrosoft365OAuthCallbackDependencies = {
  assertMicrosoft365ConnectionEnabled,
  exchangeAuthorizationCode,
  getMicrosoft365OAuthConfig,
  fetchAccountLabel,
} satisfies Microsoft365OAuthCallbackDependencies;

export const createMicrosoft365OAuthCallback = (
  dependencies: Partial<Microsoft365OAuthCallbackDependencies> = {},
) => {
  const resolved = {
    ...defaultMicrosoft365OAuthCallbackDependencies,
    ...dependencies,
  };
  return createSafeRootHandler(
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
        const gate = await resolved.assertMicrosoft365ConnectionEnabled({
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
              operation: "microsoft365_oauth_callback",
              organizationId: session.activeOrganizationId,
              request,
            }),
          });

        try {
          const stateRowsResult = await safeDb((tx) =>
            tx
              .select({
                organizationId: microsoft365OAuthState.organizationId,
                userId: microsoft365OAuthState.userId,
                codeVerifier: microsoft365OAuthState.codeVerifier,
                redirectUri: microsoft365OAuthState.redirectUri,
                createdAt: microsoft365OAuthState.createdAt,
              })
              .from(microsoft365OAuthState)
              .where(eq(microsoft365OAuthState.state, state))
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

          const oauthConfig = resolved.getMicrosoft365OAuthConfig();
          if (Result.isError(oauthConfig)) {
            return Result.ok(
              redirect({ status: "error", reason: "not-configured" }),
            );
          }

          const token = await resolved.exchangeAuthorizationCode({
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
          const account = await resolved.fetchAccountLabel(
            token.value.access_token,
          );

          if (Result.isError(account)) {
            return Result.ok(redirectForFailure(account.error));
          }
          const accountLabel = account.value;
          const encryptedAccess = await encryptMicrosoft365Secret({
            purpose: "microsoft365_access_token",
            secret: token.value.access_token,
            organizationId: row.organizationId,
            userId: rowUserId,
          });
          const encryptedRefresh = token.value.refresh_token
            ? await encryptMicrosoft365Secret({
                purpose: "microsoft365_refresh_token",
                secret: token.value.refresh_token,
                organizationId: row.organizationId,
                userId: rowUserId,
              })
            : null;

          const connectResult = await safeDb(async (innerTx) => {
            await withAggregateLock({
              tx: innerTx,
              aggregate: "organization",
              id: row.organizationId,
              mode: "update",
            });
            // Re-check enablement under the organization lock: the Graph round trips
            // above can take long enough for an admin to turn the connection
            // off mid-flow, and the check at the top of this handler ran
            // before any of that work started.
            const settingsRows = await innerTx
              .select({
                microsoft365ConnectionEnabled:
                  organizationSettings.microsoft365ConnectionEnabled,
              })
              .from(organizationSettings)
              .where(
                eq(organizationSettings.organizationId, row.organizationId),
              );
            if (!settingsRows.at(0)?.microsoft365ConnectionEnabled) {
              return { status: "not-enabled" as const };
            }

            // Authoritative on the state token: a concurrent callback for the
            // same state (replay, or a double-fired redirect) deletes zero
            // rows here and must not also persist a connection.
            const deletedState = await innerTx
              .delete(microsoft365OAuthState)
              .where(eq(microsoft365OAuthState.state, state))
              .returning({ state: microsoft365OAuthState.state });
            await innerTx
              .delete(microsoft365OAuthState)
              .where(lt(microsoft365OAuthState.createdAt, cutoff));
            if (deletedState.length === 0) {
              return { status: "state-consumed" as const };
            }

            await innerTx
              .insert(microsoft365Connections)
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
                  microsoft365Connections.organizationId,
                  microsoft365Connections.userId,
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
                operation: "microsoft365_oauth_connect",
              },
            });
            return { status: "connected" as const };
          });
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
};

const microsoft365OAuthCallback = createMicrosoft365OAuthCallback();

export default microsoft365OAuthCallback;
