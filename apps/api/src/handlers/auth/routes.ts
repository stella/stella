import Elysia from "elysia";

import { env } from "@/api/env";
import { createAuthMetadataHeaders } from "@/api/handlers/auth/metadata";
import metadataHandler from "@/api/handlers/auth/read-authorization-server-metadata";
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
      headers: createAuthMetadataHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH, metadataHandler.handler)
  .options(OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createAuthMetadataHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH, metadataHandler.handler)
  .options(OPENID_CONFIGURATION_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createAuthMetadataHeaders(),
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
