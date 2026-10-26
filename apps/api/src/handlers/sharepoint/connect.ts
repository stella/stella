import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { MICROSOFT365_CAPABILITIES } from "@stll/api-contract/microsoft365";

import { sharepointConnections, sharepointOAuthState } from "@/api/db/schema";
import { sharepointRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import {
  capabilityEnabled,
  delegatedScopes,
  LEGACY_FILE_CAPABILITIES,
} from "@/api/handlers/sharepoint/capabilities";
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkce,
  getSharepointOAuthConfig,
  getSharepointRedirectUri,
} from "@/api/handlers/sharepoint/graph-oauth";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readLockedSharepointPolicy } from "@/api/lib/sharepoint-policy-lock";

const requestBody = v.optional(
  v.object({
    capabilities: v.pipe(
      v.array(v.picklist(MICROSOFT365_CAPABILITIES)),
      v.minLength(1),
      v.maxLength(MICROSOFT365_CAPABILITIES.length),
    ),
  }),
);

const config = {
  contract: "patch",
  permissions: { integration: ["create"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: sharepointRealtimeUpdates,
  mcp: { type: "internal", reason: "provider_secret" },
  body: requestBody,
} satisfies HandlerConfig;

// Initiate the delegated Microsoft Graph consent flow: mint PKCE + state,
// persist them for the callback, and hand back the Microsoft authorize URL
// for the client to open. No token is issued here.
const connectSharepoint = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user }) {
    if (!isDeploymentFeatureEnabled("FEATURE_SHAREPOINT")) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }
    // Deployed clients omit the body; their existing consent is file-only.
    const requested = body?.capabilities ?? LEGACY_FILE_CAPABILITIES;

    const oauthConfig = getSharepointOAuthConfig();
    if (Result.isError(oauthConfig)) {
      return Result.err(oauthConfig.error);
    }

    const pkce = createPkce();
    const state = createOAuthState();
    const redirectUri = getSharepointRedirectUri();

    const scope = yield* Result.await(
      safeDb(async (tx) => {
        // The settings row is the same fence as the whole-org kill operation.
        const policy = await readLockedSharepointPolicy({
          tx,
          organizationId: session.activeOrganizationId,
          mode: "update",
        });
        if (
          requested.some((capability) => !capabilityEnabled(policy, capability))
        ) {
          return null;
        }
        const connection = (
          await tx
            .select({ scope: sharepointConnections.scope })
            .from(sharepointConnections)
            .where(
              and(
                eq(
                  sharepointConnections.organizationId,
                  session.activeOrganizationId,
                ),
                eq(sharepointConnections.userId, user.id),
              ),
            )
            .limit(1)
        ).at(0);
        const requestedScope = delegatedScopes({
          requested,
          grantedScope: connection?.scope ?? null,
          policy,
        });
        // One outstanding verifier per user; a new attempt invalidates an
        // abandoned flow and keeps the retained state bounded.
        // audit: skip — ephemeral OAuth state replacement; the resulting connection is audited at callback time.
        await tx
          .delete(sharepointOAuthState)
          .where(
            and(
              eq(
                sharepointOAuthState.organizationId,
                session.activeOrganizationId,
              ),
              eq(sharepointOAuthState.userId, user.id),
            ),
          );
        // audit: skip — ephemeral OAuth state row consumed by the callback; the resulting connection is recorded at callback time.
        await tx.insert(sharepointOAuthState).values({
          state,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          codeVerifier: pkce.codeVerifier,
          redirectUri,
          requestedScope,
        });
        return requestedScope;
      }),
    );
    if (scope === null) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Microsoft capability is not enabled for this organization",
        }),
      );
    }

    const authorizeUrl = buildAuthorizeUrl({
      clientId: oauthConfig.value.clientId,
      tenantId: oauthConfig.value.tenantId,
      codeChallenge: pkce.codeChallenge,
      redirectUri,
      scope,
      state,
    });

    return Result.ok({ authorizeUrl });
  },
);

export default connectSharepoint;
