// The stella mobile app as an OAuth client: a public native client (RFC 8252)
// identified by a Client ID Metadata Document (draft-ietf-oauth-client-id-
// metadata-document) the API publishes on its own origin. The API serves the
// document and the app builds its authorization request from this module, so
// the two cannot drift.

import { Result } from "better-result";

import { API_OAUTH_RESOURCE_SCOPES } from "./api-oauth-resource";

/** Where the document is published, relative to the issuer's origin. */
export const MOBILE_CLIENT_METADATA_PATH =
  "/v1/mcp/oauth/mobile-client-metadata.json" as const;

/**
 * The builds of the app, installable side by side: a development client, an
 * internal preview, and the store release (`apps/mobile/app.config.ts`).
 */
export const MOBILE_APP_VARIANTS = [
  "development",
  "preview",
  "production",
] as const;

export type MobileAppVariant = (typeof MOBILE_APP_VARIANTS)[number];

/**
 * RFC 8252 §7.1 private-use URI schemes: the reverse of a domain stella
 * controls, so no unrelated app plausibly claims one. Each variant registers
 * its own, so a sign-in returns to the build that started it even with all
 * three installed.
 */
export const MOBILE_REDIRECT_SCHEMES = {
  development: "app.stll.dev",
  preview: "app.stll.preview",
  production: "app.stll",
} as const satisfies Record<MobileAppVariant, string>;

/** The path the authorization server redirects to; no screen of the app. */
export const MOBILE_REDIRECT_PATH = "/oauth/callback" as const;

/** RFC 8252 §7.1: a private-use redirect has a single slash after the scheme. */
export const mobileRedirectUri = (variant: MobileAppVariant): string =>
  `${MOBILE_REDIRECT_SCHEMES[variant]}:${MOBILE_REDIRECT_PATH}`;

/** Every variant's redirect, which the one published client document lists. */
export const MOBILE_REDIRECT_URIS: readonly string[] =
  MOBILE_APP_VARIANTS.map(mobileRedirectUri);

export const MOBILE_CLIENT_NAME = "stella mobile" as const;

/**
 * `offline_access` makes the provider issue a refresh token; without it the
 * app would need a browser sign-in every time the access token expires.
 */
export const MOBILE_IDENTITY_SCOPES = ["openid", "offline_access"] as const;

/** Everything the REST API grants its own apps; the app asks for all of it. */
export const MOBILE_RESOURCE_SCOPES = API_OAUTH_RESOURCE_SCOPES;

export const MOBILE_SCOPES = [
  ...MOBILE_IDENTITY_SCOPES,
  ...MOBILE_RESOURCE_SCOPES,
] as const;

export type MobileClientMetadataDocument = {
  readonly client_id: string;
  readonly client_name: typeof MOBILE_CLIENT_NAME;
  readonly application_type: "native";
  readonly grant_types: readonly ["authorization_code", "refresh_token"];
  readonly redirect_uris: readonly string[];
  readonly response_types: readonly ["code"];
  readonly scope: string;
  readonly token_endpoint_auth_method: "none";
};

/**
 * The app's `client_id` for an authorization server: the document URL on the
 * issuer's origin. Undefined when the issuer is not https, since a metadata
 * document `client_id` must be an https URL; the app registers a client there
 * instead.
 */
export const mobileClientMetadataUrl = (issuer: string): string | undefined => {
  // Not `URL.parse`: the mobile app's runtime predates that static.
  const parsed = Result.try(() => new URL(issuer));
  if (Result.isError(parsed) || parsed.value.protocol !== "https:") {
    return undefined;
  }
  return new URL(MOBILE_CLIENT_METADATA_PATH, parsed.value.origin).toString();
};

/** The published document for the mobile client identified by `clientId`. */
export const buildMobileClientMetadataDocument = (
  clientId: string,
): MobileClientMetadataDocument => ({
  client_id: clientId,
  client_name: MOBILE_CLIENT_NAME,
  application_type: "native",
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: MOBILE_REDIRECT_URIS,
  response_types: ["code"],
  scope: MOBILE_SCOPES.join(" "),
  token_endpoint_auth_method: "none",
});
