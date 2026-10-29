import type { AuthSocialProviderId } from "@stll/auth-model";

import { env } from "@/api/env";
import { createAuthMetadataPreflightHeaders } from "@/api/handlers/auth/metadata";
import metadataHandler from "@/api/handlers/auth/read-authorization-server-metadata";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import { configuredAppleSignIn } from "@/api/lib/auth/apple-sign-in-env";
import {
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
} from "@/api/lib/auth/auth-paths";
import { isReviewAccountConfigured } from "@/api/lib/auth/review-account";
import { isTransactionalEmailConfigured } from "@/api/lib/email/email";
import { defineEndpoint } from "@/api/lib/endpoints";
import {
  isSelfhostFirstUserRequired,
  isSelfhostLocalPasswordAuthEnabled,
} from "@/api/lib/selfhost-auth";

/**
 * A discovery document's preflight, answered by the route itself so the
 * credentialed CORS layer never sees it: any origin may read the metadata,
 * a third-party MCP client's included.
 */
const metadataPreflight = defineEndpoint.public({ cors: "own" }, ({ set }) => {
  for (const [key, value] of createAuthMetadataPreflightHeaders()) {
    set.headers[key] = value;
  }
  return status(204);
});

export const authMetadataRoute = routes({
  [ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH]: {
    GET: metadataHandler,
    OPTIONS: metadataPreflight,
  },
  [OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH]: {
    GET: metadataHandler,
    OPTIONS: metadataPreflight,
  },
  [OPENID_CONFIGURATION_DISCOVERY_PATH]: {
    GET: metadataHandler,
    OPTIONS: metadataPreflight,
  },
});

const getSocialAuthCapabilities = () =>
  ({
    google: !!(env.GOOGLE_AUTH_CLIENT_ID && env.GOOGLE_AUTH_CLIENT_SECRET),
    microsoft: !!(
      env.MICROSOFT_AUTH_CLIENT_ID &&
      env.MICROSOFT_AUTH_CLIENT_SECRET &&
      env.MICROSOFT_AUTH_TENANT_ID
    ),
    apple: configuredAppleSignIn().type === "enabled",
  }) satisfies Record<AuthSocialProviderId, boolean>;

const authCapabilities = defineEndpoint.public({}, async () => {
  const firstUserRequired = await isSelfhostFirstUserRequired();
  const bootstrap = firstUserRequired && !!env.SELFHOST_BOOTSTRAP_TOKEN;
  return {
    emailOtp: isTransactionalEmailConfigured() && !firstUserRequired,
    localPassword: isSelfhostLocalPasswordAuthEnabled(),
    // One restricted account signs in with a password; the sign-in page
    // offers the form quietly instead of as a primary option.
    reviewPasswordSignIn: isReviewAccountConfigured(),
    bootstrap,
    social: getSocialAuthCapabilities(),
    // Whether this deployment can deliver a confirmation code at all. Separate
    // from `emailOtp` (a sign-in option, which the bootstrap state also
    // suppresses): account settings read this to decide whether an emailed
    // confirmation step is part of a flow.
    transactionalEmail: isTransactionalEmailConfigured(),
  };
});

export const authCapabilitiesRoute = routes(
  { "/capabilities": { GET: authCapabilities } },
  { prefix: "/auth" },
);
