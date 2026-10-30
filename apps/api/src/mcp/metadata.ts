import { STELLA_LOGO_FILE_NAME } from "@stll/api-contract/stella-logo";

import { env } from "@/api/env";
import { PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS } from "@/api/handlers/public-cors";
import { getAuthIssuerUrl } from "@/api/lib/auth/auth-paths";
import type { McpMode } from "@/api/mcp/constants";
import {
  getMcpProtectedResourceMetadataUrl,
  getMcpResourceScopes,
  getMcpResourceUrl,
  MCP_ALLOWED_HEADERS,
  MCP_DISCOVERY_ALLOW_HEADER,
  MCP_DISCOVERY_ALLOWED_HEADERS,
  MCP_EXPOSE_HEADERS,
  MCP_STATELESS_ALLOW_HEADER,
  STELLA_API_CONTRACT,
  STELLA_CLI_LATEST_HEADER,
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MINIMUM_HEADER,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_HEADER,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";

export const createMcpMetadataHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": MCP_DISCOVERY_ALLOW_HEADER,
    "Access-Control-Allow-Headers": MCP_DISCOVERY_ALLOWED_HEADERS.join(", "),
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS.join(", "),
    [STELLA_MCP_API_CONTRACT_HEADER]: String(STELLA_MCP_API_CONTRACT_VERSION),
    [STELLA_CLI_MINIMUM_HEADER]: STELLA_CLI_MINIMUM_VERSION,
    [STELLA_CLI_LATEST_HEADER]: STELLA_CLI_LATEST_VERSION,
  });

export const createMcpCorsHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": MCP_STATELESS_ALLOW_HEADER,
    "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS.join(", "),
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS.join(", "),
    "Access-Control-Max-Age": String(PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS),
    [STELLA_MCP_API_CONTRACT_HEADER]: String(STELLA_MCP_API_CONTRACT_VERSION),
    [STELLA_CLI_MINIMUM_HEADER]: STELLA_CLI_MINIMUM_VERSION,
    [STELLA_CLI_LATEST_HEADER]: STELLA_CLI_LATEST_VERSION,
  });

/**
 * The endpoint answers its own preflight (the global CORS layer is bypassed for
 * MCP paths), so `Allow` and `Access-Control-Allow-Methods` state the same
 * method set the transport actually serves. No
 * `Access-Control-Allow-Credentials`: this endpoint is bearer-authenticated and
 * never reads cookies, and a browser rejects credentialed requests answered
 * with `Access-Control-Allow-Origin: *`.
 */
export const createMcpPreflightHeaders = () => {
  const headers = createMcpCorsHeaders();
  headers.set("Allow", MCP_STATELESS_ALLOW_HEADER);
  return headers;
};

export const createMcpDiscoveryPreflightHeaders = () => {
  const headers = createMcpMetadataHeaders();
  headers.set("Allow", MCP_DISCOVERY_ALLOW_HEADER);
  headers.set(
    "Access-Control-Max-Age",
    String(PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS),
  );
  return headers;
};

// User-facing identifiers (auth.md PRM) shown to a person during the agent
// claim ceremony and by MCP hosts listing the connector. The logo is a raster
// PNG the web app serves from `@stll/api-contract`: several hosts do not render
// SVG icons, so every advertised logo points at this one file.
const RESOURCE_NAME = "stella";
export const MCP_LOGO_PATH = STELLA_LOGO_FILE_NAME;
export const getMcpLogoUri = () =>
  new URL(MCP_LOGO_PATH, `${env.FRONTEND_URL.replace(/\/$/u, "")}/`).toString();

/** MCP `Implementation.icons` entry for `serverInfo`, same file as the PRM logo. */
export const getMcpServerIcons = () => [
  { src: getMcpLogoUri(), mimeType: "image/png", sizes: ["512x512"] },
];

export const getMcpProtectedResourceMetadata = (mode: McpMode = "default") => ({
  resource: getMcpResourceUrl(mode),
  resource_name: RESOURCE_NAME,
  resource_logo_uri: getMcpLogoUri(),
  authorization_servers: [getAuthIssuerUrl()],
  scopes_supported: [...getMcpResourceScopes(mode)],
  bearer_methods_supported: ["header"],
  stella_contract: {
    protocol: STELLA_API_CONTRACT.protocol,
    revision: STELLA_API_CONTRACT.revision,
    capabilities: { ...STELLA_API_CONTRACT.capabilities },
  },
  // RFC 9728 permits additional protected-resource metadata parameters and
  // requires clients to ignore ones they do not understand. Keep the old
  // package-version extension during the transition so already-published CLIs
  // continue to parse discovery; new CLIs prefer `stella_contract` above.
  stella_compatibility: {
    api_contract_version: STELLA_MCP_API_CONTRACT_VERSION,
    cli_version: {
      minimum: STELLA_CLI_MINIMUM_VERSION,
      maximum: STELLA_CLI_LATEST_VERSION,
    },
  },
});

/**
 * RFC 6750 §3.1 `error` code carried by the challenge. `none` is the omission
 * the RFC requires when the request presented no credentials at all: a client
 * must read that challenge as "authenticate", not as "your token was refused".
 * It is also what a valid token denied for a non-credential reason gets, since
 * no re-authorization the client can perform would change the outcome.
 */
const MCP_CHALLENGE_ERRORS = [
  "none",
  "invalid_token",
  "insufficient_scope",
] as const;
export type McpChallengeError = (typeof MCP_CHALLENGE_ERRORS)[number];

/** Auth params preceding `resource_metadata`; each non-empty one ends in its separator. */
const CHALLENGE_ERROR_PARAMS = {
  none: "",
  invalid_token:
    'error="invalid_token", error_description="The access token is expired, revoked, or not valid for this resource", ',
  // RFC 6750 §3.1: the token is valid but its grant lacks a scope this call
  // needs. Hosts that read a tool-level challenge re-run consent from it.
  insufficient_scope:
    'error="insufficient_scope", error_description="Reconnect stella to grant the permission this action needs", ',
} as const satisfies Record<McpChallengeError, string>;

export const getMcpWwwAuthenticateHeader = ({
  error = "none",
  mode = "default",
}: { error?: McpChallengeError; mode?: McpMode } = {}) =>
  `Bearer ${CHALLENGE_ERROR_PARAMS[error]}resource_metadata="${getMcpProtectedResourceMetadataUrl(mode)}"`;
