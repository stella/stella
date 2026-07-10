import Elysia from "elysia";

import { env } from "@/api/env";
import {
  createAuthMetadataHeaders,
  handleOAuthAuthorizationServerMetadataRequest,
} from "@/api/handlers/auth/metadata";
import {
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
} from "@/api/lib/auth-paths";
import { isTransactionalEmailConfigured } from "@/api/lib/email";
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
  .options(ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createAuthMetadataHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(
    ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
    async ({ request }) =>
      await handleOAuthAuthorizationServerMetadataRequest(request),
  )
  .options(OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createAuthMetadataHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(
    OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
    async ({ request }) =>
      await handleOAuthAuthorizationServerMetadataRequest(request),
  )
  .options(OPENID_CONFIGURATION_DISCOVERY_PATH, ({ set }) => {
    applyHeaders({
      headers: createAuthMetadataHeaders(),
      set,
    });
    set.status = 204;
    return "";
  })
  .get(
    OPENID_CONFIGURATION_DISCOVERY_PATH,
    async ({ request }) =>
      await handleOAuthAuthorizationServerMetadataRequest(request),
  );

export const authCapabilitiesRoute = new Elysia({
  prefix: "/auth",
}).get("/capabilities", async () => {
  const firstUserRequired = await isSelfhostFirstUserRequired();
  const bootstrap = firstUserRequired && !!env.SELFHOST_BOOTSTRAP_TOKEN;
  return {
    emailOtp: isTransactionalEmailConfigured() && !firstUserRequired,
    localPassword: isSelfhostLocalPasswordAuthEnabled(),
    bootstrap,
    social: getSocialAuthCapabilities(),
  };
});
