import { Result } from "better-result";

import { sharepointOAuthState } from "@/api/db/schema";
import { assertSharepointConnectionEnabled } from "@/api/handlers/sharepoint/enablement";
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkce,
  getSharepointOAuthConfig,
  getSharepointRedirectUri,
} from "@/api/handlers/sharepoint/graph-oauth";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

// Initiate the delegated Microsoft Graph consent flow: mint PKCE + state,
// persist them for the callback, and hand back the Microsoft authorize URL
// for the client to open. No token is issued here.
const connectSharepoint = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    yield* Result.await(
      assertSharepointConnectionEnabled({
        organizationId: session.activeOrganizationId,
        safeDb,
      }),
    );

    const oauthConfig = getSharepointOAuthConfig();
    if (Result.isError(oauthConfig)) {
      return Result.err(oauthConfig.error);
    }

    const pkce = createPkce();
    const state = createOAuthState();
    const redirectUri = getSharepointRedirectUri();

    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — ephemeral OAuth state row consumed by the callback; the resulting connection is recorded at callback time.
        await tx.insert(sharepointOAuthState).values({
          state,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          codeVerifier: pkce.codeVerifier,
          redirectUri,
        });
      }),
    );

    const authorizeUrl = buildAuthorizeUrl({
      clientId: oauthConfig.value.clientId,
      tenantId: oauthConfig.value.tenantId,
      codeChallenge: pkce.codeChallenge,
      redirectUri,
      state,
    });

    return Result.ok({ authorizeUrl });
  },
);

export default connectSharepoint;
