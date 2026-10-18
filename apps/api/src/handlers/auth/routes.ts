import Elysia from "elysia";

import { env } from "@/api/env";
import { createAuthMetadataPreflightHeaders } from "@/api/handlers/auth/metadata";
import metadataHandler from "@/api/handlers/auth/read-authorization-server-metadata";
import { dropCredentialedCors } from "@/api/handlers/public-cors";
import {
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
} from "@/api/lib/auth/auth-paths";
import { isReviewAccountConfigured } from "@/api/lib/auth/review-account";
import { isTransactionalEmailConfigured } from "@/api/lib/email/email";
import { setSecurityHeaders } from "@/api/lib/security-headers";
import {
  isSelfhostFirstUserRequired,
  isSelfhostLocalPasswordAuthEnabled,
} from "@/api/lib/selfhost-auth";

const applyHeaders = ({
  headers,
  set,
}: {
  headers: Headers;
  set: { headers: Record<string, string | number | boolean | undefined> };
}) => {
  for (const [key, value] of headers) {
    set.headers[key] = value;
  }
};

const AUTH_METADATA_DISCOVERY_PATHS: ReadonlySet<string> = new Set([
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
]);

/**
 * The discovery documents are public and read from any origin, but the global
 * CORS layer answers every preflight before routing, for the browser origins
 * the app trusts and with credentials. A third-party MCP client's preflight
 * would get no `Access-Control-Allow-Origin` at all, so it is answered here,
 * ahead of that layer, the same way the protected-resource documents are.
 */
export const handleAuthMetadataPreflightRequest = (
  request: Request,
  set: { headers: Record<string, string | number | boolean | undefined> },
): Response | undefined => {
  if (
    request.method !== "OPTIONS" ||
    !AUTH_METADATA_DISCOVERY_PATHS.has(new URL(request.url).pathname)
  ) {
    return undefined;
  }
  dropCredentialedCors(set);
  return new Response(null, {
    headers: createAuthMetadataPreflightHeaders(),
    status: 204,
  });
};

const getSocialAuthCapabilities = () => ({
  google: !!(env.GOOGLE_AUTH_CLIENT_ID && env.GOOGLE_AUTH_CLIENT_SECRET),
  microsoft: !!(
    env.MICROSOFT_AUTH_CLIENT_ID &&
    env.MICROSOFT_AUTH_CLIENT_SECRET &&
    env.MICROSOFT_AUTH_TENANT_ID
  ),
});

export const authMetadataRoute = new Elysia()
  .onRequest(({ set }) => {
    setSecurityHeaders(set);
  })
  .options(ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createAuthMetadataPreflightHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH, metadataHandler.handler)
  .options(OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createAuthMetadataPreflightHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH, metadataHandler.handler)
  .options(OPENID_CONFIGURATION_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createAuthMetadataPreflightHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(OPENID_CONFIGURATION_DISCOVERY_PATH, metadataHandler.handler);

export const authCapabilitiesRoute = new Elysia({
  prefix: "/auth",
}).get("/capabilities", async () => {
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
