// The CLI's OAuth Client ID Metadata Document (draft-ietf-oauth-client-id-
// metadata-document). The server publishes it and the CLI uses its URL as
// `client_id`; both build it from this module so the two cannot drift.

import {
  CLI_KNOWN_SCOPES,
  CLIENT_NAME,
  LOOPBACK_REDIRECT_PATH,
} from "./constants.js";

/** Where the document is published, relative to the issuer's origin. */
export const CLI_CLIENT_METADATA_PATH =
  "/v1/mcp/oauth/cli-client-metadata.json" as const;

export type CliClientMetadataDocument = {
  readonly client_id: string;
  readonly client_name: string;
  readonly application_type: "native";
  readonly grant_types: readonly ["authorization_code", "refresh_token"];
  readonly redirect_uris: readonly string[];
  readonly response_types: readonly ["code"];
  readonly scope: string;
  readonly token_endpoint_auth_method: "none";
};

/**
 * The CLI's `client_id` for an authorization server: the document URL on the
 * issuer's origin. Undefined when the issuer is not https, since a metadata
 * document `client_id` must be an https URL (local servers keep registering
 * a client instead).
 */
export const cliClientMetadataUrl = (issuer: string): string | undefined => {
  const url = URL.parse(issuer);
  if (!url || url.protocol !== "https:") {
    return undefined;
  }
  return new URL(CLI_CLIENT_METADATA_PATH, url.origin).toString();
};

/** The published document for the CLI client identified by `clientId`. */
export const buildCliClientMetadataDocument = (
  clientId: string,
): CliClientMetadataDocument => ({
  client_id: clientId,
  client_name: CLIENT_NAME,
  application_type: "native",
  grant_types: ["authorization_code", "refresh_token"],
  // Loopback redirects match on any port (RFC 8252 §7.3).
  redirect_uris: [
    `http://127.0.0.1${LOOPBACK_REDIRECT_PATH}`,
    `http://localhost${LOOPBACK_REDIRECT_PATH}`,
  ],
  response_types: ["code"],
  scope: CLI_KNOWN_SCOPES.join(" "),
  token_endpoint_auth_method: "none",
});
