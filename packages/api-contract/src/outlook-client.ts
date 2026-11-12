// The stella Outlook add-in as an OAuth client: a public browser client
// (authorization code + PKCE, no secret) identified by a Client ID Metadata
// Document the API publishes on its own origin. The add-in's task pane runs
// on its own https origin, which each deployment configures on the API; the
// authorization server returns only to a page on that origin, opened inside
// an Office dialog. The API serves the document and the add-in builds its
// authorization request from this module, so the two cannot drift.

import type { ApiOAuthResourceScope } from "./api-oauth-resource";

/** Where the document is published, relative to the issuer's origin. */
export const OUTLOOK_CLIENT_METADATA_PATH =
  "/v1/mcp/oauth/outlook-client-metadata.json" as const;

/** The task-pane page the authorization server redirects to. */
export const OUTLOOK_REDIRECT_PATH = "/auth/callback.html" as const;

export const OUTLOOK_CLIENT_NAME = "stella for Outlook" as const;

/**
 * `offline_access` makes the provider issue a refresh token, so the task pane
 * does not reopen the sign-in dialog every time the access token expires.
 */
export const OUTLOOK_IDENTITY_SCOPES = ["openid", "offline_access"] as const;

/**
 * Only what the add-in does: list matters, file a message into one, and the
 * AI summary and reply draft. It never writes matters or billing.
 */
export const OUTLOOK_RESOURCE_SCOPES = [
  "stella:read",
  "stella:documents_write",
  "stella:chat",
] as const satisfies readonly ApiOAuthResourceScope[];

export const OUTLOOK_SCOPES = [
  ...OUTLOOK_IDENTITY_SCOPES,
  ...OUTLOOK_RESOURCE_SCOPES,
] as const;

/**
 * The task pane's https origin, normalized, or undefined when the value is
 * not exactly an https origin (no path, query, fragment or credentials).
 */
export const normalizeOutlookTaskPaneOrigin = (
  value: string,
): string | undefined => {
  const parsed = URL.parse(value);
  if (
    parsed?.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    return undefined;
  }
  return parsed.origin;
};

/** The one redirect URI for a task pane served from `taskPaneOrigin`. */
export const outlookRedirectUri = (taskPaneOrigin: string): string =>
  new URL(OUTLOOK_REDIRECT_PATH, taskPaneOrigin).toString();

/**
 * The add-in's `client_id` for an authorization server: the document URL on
 * the issuer's origin. Undefined when the issuer is not https, since a
 * metadata document `client_id` must be an https URL.
 */
export const outlookClientMetadataUrl = (
  issuer: string,
): string | undefined => {
  const parsed = URL.parse(issuer);
  if (parsed?.protocol !== "https:") {
    return undefined;
  }
  return new URL(OUTLOOK_CLIENT_METADATA_PATH, parsed.origin).toString();
};

export type OutlookClientMetadataDocument = {
  readonly client_id: string;
  readonly client_name: typeof OUTLOOK_CLIENT_NAME;
  readonly application_type: "web";
  readonly grant_types: readonly ["authorization_code", "refresh_token"];
  readonly redirect_uris: readonly [string];
  readonly response_types: readonly ["code"];
  readonly scope: string;
  readonly token_endpoint_auth_method: "none";
};

/** The published document for the add-in served from `taskPaneOrigin`. */
export const buildOutlookClientMetadataDocument = ({
  clientId,
  taskPaneOrigin,
}: {
  clientId: string;
  taskPaneOrigin: string;
}): OutlookClientMetadataDocument => ({
  client_id: clientId,
  client_name: OUTLOOK_CLIENT_NAME,
  application_type: "web",
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: [outlookRedirectUri(taskPaneOrigin)],
  response_types: ["code"],
  scope: OUTLOOK_SCOPES.join(" "),
  token_endpoint_auth_method: "none",
});
