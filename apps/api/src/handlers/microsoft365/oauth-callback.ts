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
import { assertMicrosoft365ConnectionEnabled } from "@/api/handlers/microsoft365/enablement";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  capabilityEnabled,
  consentedScopes,
  grantedCapabilities,
  scopeSet,
} from "@/api/lib/auth/microsoft365/capabilities";
import {
  MICROSOFT365_TOKEN_PURPOSE,
  encryptMicrosoft365Secret,
} from "@/api/lib/auth/microsoft365/crypto";
import { fetchAccountLabel } from "@/api/lib/auth/microsoft365/graph-client";
import {
  exchangeMicrosoft365AuthorizationCode,
  getMicrosoft365OAuthConfig,
  tokenExpiresAt,
} from "@/api/lib/auth/microsoft365/graph-oauth";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transition } from "@/api/lib/db/transitions";
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
  exchangeMicrosoft365AuthorizationCode: typeof exchangeMicrosoft365AuthorizationCode;
  getMicrosoft365OAuthConfig: typeof getMicrosoft365OAuthConfig;
  fetchAccountLabel: typeof fetchAccountLabel;
};

const defaultMicrosoft365OAuthCallbackDependencies = {
  assertMicrosoft365ConnectionEnabled,
  exchangeMicrosoft365AuthorizationCode,
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

        // Every failure redirects to the settings surface, including a database
        // Result.err and a rejection from an external crypto or provider call.
        const redirectForFailure = (error: unknown) =>
          redirect({
            status: "error",
            reason: oauthCallbackFailureReason(error, {
              operation: "microsoft365_oauth_callback",
              organizationId: session.activeOrganizationId,
              request,
            }),
          });

        const settled = await Result.tryPromise({
          try: async () => {
            const stateRowsResult = await safeDb((tx) =>
              tx
                .select({
                  organizationId: microsoft365OAuthState.organizationId,
                  userId: microsoft365OAuthState.userId,
                  codeVerifier: microsoft365OAuthState.codeVerifier,
                  redirectUri: microsoft365OAuthState.redirectUri,
                  requestedScope: microsoft365OAuthState.requestedScope,
                  createdAt: microsoft365OAuthState.createdAt,
                })
                .from(microsoft365OAuthState)
                .where(eq(microsoft365OAuthState.stateToken, state))
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

            const permit = grantThirdPartyOutboundPermit();
            const token = await resolved.exchangeMicrosoft365AuthorizationCode({
              clientId: oauthConfig.value.clientId,
              clientSecret: oauthConfig.value.clientSecret,
              tenantId: oauthConfig.value.tenantId,
              code,
              codeVerifier: row.codeVerifier,
              redirectUri: row.redirectUri,
              permit,
            });
            if (Result.isError(token)) {
              return Result.ok(
                redirect({ status: "error", reason: "token-exchange" }),
              );
            }

            const rowUserId = brandPersistedUserId(row.userId);
            const account = await resolved.fetchAccountLabel(
              token.value.access_token,
              permit,
            );

            if (Result.isError(account)) {
              return Result.ok(redirectForFailure(account.error));
            }
            const accountLabel = account.value;
            const encryptedAccess = await encryptMicrosoft365Secret({
              purpose: MICROSOFT365_TOKEN_PURPOSE.access,
              secret: token.value.access_token,
              organizationId: row.organizationId,
              userId: rowUserId,
            });
            const encryptedRefresh = token.value.refresh_token
              ? await encryptMicrosoft365Secret({
                  purpose: MICROSOFT365_TOKEN_PURPOSE.refresh,
                  secret: token.value.refresh_token,
                  organizationId: row.organizationId,
                  userId: rowUserId,
                })
              : null;

            const connectResult = await safeDb(async (innerTx) => {
              await withAggregateLock({
                tx: innerTx,
                aggregate: "orgFeatureAdmission",
                id: {
                  organizationId: row.organizationId,
                  featureId: "microsoft365",
                },
              });
              // Re-check enablement under the connection policy lock: the Graph round trips
              // above can take long enough for an admin to turn the connection
              // off mid-flow, and the check at the top of this handler ran
              // before any of that work started.
              const settingsRows = await innerTx
                .select({
                  microsoft365ConnectionEnabled:
                    organizationSettings.microsoft365ConnectionEnabled,
                  microsoft365FilesReadEnabled:
                    organizationSettings.microsoft365FilesReadEnabled,
                  microsoft365CalendarReadEnabled:
                    organizationSettings.microsoft365CalendarReadEnabled,
                })
                .from(organizationSettings)
                .where(
                  eq(organizationSettings.organizationId, row.organizationId),
                );
              const policy = settingsRows.at(0);
              if (!policy?.microsoft365ConnectionEnabled) {
                return { status: "not-enabled" as const };
              }

              // Authoritative on the state token: a concurrent callback for the
              // same state (replay, or a double-fired redirect) deletes zero
              // rows here and must not also persist a connection.
              const deletedState = await innerTx
                .delete(microsoft365OAuthState)
                .where(eq(microsoft365OAuthState.stateToken, state))
                .returning({ state: microsoft365OAuthState.stateToken });
              await innerTx
                .delete(microsoft365OAuthState)
                .where(lt(microsoft365OAuthState.createdAt, cutoff));
              if (deletedState.length === 0) {
                return { status: "state-consumed" as const };
              }

              const requestedCapabilities = grantedCapabilities(
                row.requestedScope,
              );
              const scope = consentedScopes({
                grantedScope: token.value.scope ?? null,
                requestedScope: row.requestedScope,
                policy,
              });
              const capabilities = grantedCapabilities(scope);
              if (
                requestedCapabilities.length === 0 ||
                requestedCapabilities.some(
                  (capability) =>
                    !capabilityEnabled(policy, capability) ||
                    !capabilities.includes(capability),
                )
              ) {
                return { status: "capability-not-granted" as const };
              }

              const [stored] = await innerTx
                .insert(microsoft365Connections)
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
                    microsoft365Connections.organizationId,
                    microsoft365Connections.userId,
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
                    updatedAt: new Date(),
                  },
                })
                .returning({ id: microsoft365Connections.id });
              // Fresh consent revives a connection that needed reconnecting;
              // a row that was already connected has no transition to make.
              const revived = await transition({
                tx: innerTx,
                spec: TRANSITIONS.microsoft365Connections,
                id:
                  stored?.id ?? panic("The connection upsert returns its row"),
                options: {
                  from: ["reconnect_required"],
                  to: "connected",
                  fence: encryptedAccess.ciphertext,
                },
                // The connect audit below records this consent.
                recordTransitionAuditEvent: async () => await Promise.resolve(),
              });
              await recordAuditEvent(innerTx, {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
                resourceId: row.organizationId,
                workspaceId: null,
                metadata: {
                  connectionUserId: rowUserId,
                  operation: "microsoft365_oauth_connect",
                  grantedScopes: scopeSet(scope),
                  grantedCapabilities: capabilities,
                  reconnected: revived.type === "transitioned",
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
              case "capability-not-granted": {
                return Result.ok(
                  redirect({
                    status: "error",
                    reason: "capability-not-granted",
                  }),
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
          },
          catch: (error: unknown) => error,
        });
        return Result.isError(settled)
          ? Result.ok(redirectForFailure(settled.error))
          : settled.value;
      };

      // Failure branches resolve as redirects, preserving the callback response contract.
      return Result.ok(yield* Result.await(run()));
    },
  );
};

const microsoft365OAuthCallback = createMicrosoft365OAuthCallback();

export default microsoft365OAuthCallback;
