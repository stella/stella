import { env } from "@/api/env";

/** Where Better Auth serves its own endpoints (its default `basePath`). */
export const AUTH_API_PATH = "/api/auth" as const;

/** Every Better Auth endpoint, as one route the API hands to Better Auth. */
export const AUTH_API_ROUTE = `${AUTH_API_PATH}/*` as const;

export const OAUTH_UI_LOGIN_PATH = "/oauth-ui/auth" as const;
export const OAUTH_UI_ORGANIZATION_PATH =
  "/oauth-ui/auth/organization" as const;
export const OAUTH_UI_CONSENT_PATH = "/oauth-ui/consent" as const;

export const ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH =
  "/.well-known/oauth-authorization-server" as const;

export const OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH =
  `/.well-known/oauth-authorization-server${AUTH_API_PATH}` as const;

export const OPENID_CONFIGURATION_DISCOVERY_PATH =
  "/.well-known/openid-configuration" as const;

const withTrailingSlash = (url: string) => `${url.replace(/\/$/u, "")}/`;

const authBaseUrl = (origin: string) =>
  new URL(AUTH_API_PATH.slice(1), withTrailingSlash(origin)).toString();

/** Stable machine-token issuer, independent of the browser auth transport. */
export const getAuthIssuerUrl = () =>
  authBaseUrl(env.PUBLIC_URL ?? env.BETTER_AUTH_URL);

/** Active auth transport used for browser callbacks and JWKS discovery. */
export const getAuthEndpointUrl = (path: string) =>
  new URL(path, withTrailingSlash(authBaseUrl(env.BETTER_AUTH_URL))).toString();
