import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { MICROSOFT365_CAPABILITIES } from "@stll/api-contract/microsoft365";

import { microsoft365OAuthState } from "@/api/db/schema";
import { assertMicrosoft365ConnectionEnabled } from "@/api/handlers/microsoft365/enablement";
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkce,
  getMicrosoft365OAuthConfig,
  getMicrosoft365RedirectUri,
} from "@/api/handlers/microsoft365/graph-oauth";
import { microsoft365RealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { capabilityEnabled, delegatedScopes } from "./capabilities";

const config = {
  body: t.Object({
    capabilities: t.Array(t.UnionEnum(MICROSOFT365_CAPABILITIES), {
      minItems: 1,
      maxItems: 2,
    }),
  }),
  contract: "patch",
  permissions: { integration: ["create"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: microsoft365RealtimeUpdates,
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

// Initiate the delegated Microsoft Graph consent flow: mint PKCE + state,
// persist them for the callback, and hand back the Microsoft authorize URL
// for the client to open. No token is issued here.
const connectMicrosoft365 = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user }) {
    yield* Result.await(
      assertMicrosoft365ConnectionEnabled({
        organizationId: session.activeOrganizationId,
        safeDb,
        capabilities: body.capabilities,
      }),
    );

    const oauthConfig = getMicrosoft365OAuthConfig();
    if (Result.isError(oauthConfig)) {
      return Result.err(oauthConfig.error);
    }

    const pkce = createPkce();
    const state = createOAuthState();
    const redirectUri = getMicrosoft365RedirectUri();

    const scope = yield* Result.await(
      safeDb(async (tx) => {
        await withAggregateLock({
          tx,
          aggregate: "organization",
          id: session.activeOrganizationId,
          mode: "update",
        });
        const policy = await tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            microsoft365ConnectionEnabled: true,
            microsoft365FilesReadEnabled: true,
            microsoft365CalendarReadEnabled: true,
          },
        });
        if (
          body.capabilities.some(
            (capability) => !capabilityEnabled(policy, capability),
          )
        ) {
          return null;
        }
        const connection = await tx.query.microsoft365Connections.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
            userId: { eq: user.id },
          },
          columns: { scope: true },
        });
        // Keep one pending consent attempt per member; starting again invalidates
        // an abandoned attempt and bounds retained PKCE verifiers.
        // audit: skip — replace ephemeral OAuth state before creating the next attempt.
        await tx
          .delete(microsoft365OAuthState)
          .where(
            and(
              eq(
                microsoft365OAuthState.organizationId,
                session.activeOrganizationId,
              ),
              eq(microsoft365OAuthState.userId, user.id),
            ),
          );
        // audit: skip — ephemeral OAuth state row consumed by the callback; the resulting connection is recorded at callback time.
        await tx.insert(microsoft365OAuthState).values({
          state,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          codeVerifier: pkce.codeVerifier,
          redirectUri,
        });
        return delegatedScopes(body.capabilities, connection?.scope ?? null);
      }),
    );

    if (scope === null) {
      return Result.err(
        new HandlerError({
          status: 403,
          message:
            "Microsoft 365 capability is not enabled for this organization",
        }),
      );
    }
    const authorizeUrl = buildAuthorizeUrl({
      clientId: oauthConfig.value.clientId,
      tenantId: oauthConfig.value.tenantId,
      codeChallenge: pkce.codeChallenge,
      redirectUri,
      state,
      scope,
    });

    return Result.ok({ authorizeUrl });
  },
);

export default connectMicrosoft365;
