import { env } from "@/api/env";

export const AUTH_API_PATH = "/api/auth" as const;

export const ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH =
  "/.well-known/oauth-authorization-server" as const;

export const OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH =
  `/.well-known/oauth-authorization-server${AUTH_API_PATH}` as const;

export const OPENID_CONFIGURATION_DISCOVERY_PATH =
  "/.well-known/openid-configuration" as const;

const withTrailingSlash = (url: string) => `${url.replace(/\/$/, "")}/`;

export const getAuthIssuerUrl = () =>
  new URL(
    AUTH_API_PATH.slice(1),
    withTrailingSlash(env.BETTER_AUTH_URL),
  ).toString();

export const getAuthEndpointUrl = (path: string) =>
  new URL(path, withTrailingSlash(getAuthIssuerUrl())).toString();
