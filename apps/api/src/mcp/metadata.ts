import { env } from "@/api/env";
import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import type { McpMode } from "@/api/mcp/constants";
import {
  getMcpResourceScopes,
  getMcpProtectedResourceMetadataUrl,
  getMcpResourceUrl,
  MCP_ALLOWED_HEADERS,
  MCP_DISCOVERY_ALLOW_HEADER,
  MCP_EXPOSE_HEADERS,
  MCP_STATELESS_ALLOW_HEADER,
  STELLA_API_CONTRACT,
  STELLA_CLI_MAXIMUM_VERSION,
  STELLA_CLI_MINIMUM_HEADER,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_HEADER,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";

export const createMcpMetadataHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": MCP_DISCOVERY_ALLOW_HEADER,
    "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS.join(", "),
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS.join(", "),
    "Cache-Control": "public, max-age=300",
    [STELLA_MCP_API_CONTRACT_HEADER]: String(STELLA_MCP_API_CONTRACT_VERSION),
    [STELLA_CLI_MINIMUM_HEADER]: STELLA_CLI_MINIMUM_VERSION,
  });

export const createMcpCorsHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": MCP_STATELESS_ALLOW_HEADER,
    "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS.join(", "),
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS.join(", "),
    "Access-Control-Max-Age": "86400",
    [STELLA_MCP_API_CONTRACT_HEADER]: String(STELLA_MCP_API_CONTRACT_VERSION),
    [STELLA_CLI_MINIMUM_HEADER]: STELLA_CLI_MINIMUM_VERSION,
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
  return headers;
};

// User-facing identifiers (auth.md PRM) shown to a person during the agent
// claim ceremony. The logo is served from the web app's public assets.
const RESOURCE_NAME = "stella";
const getResourceLogoUri = () =>
  new URL("favicon.svg", `${env.FRONTEND_URL.replace(/\/$/u, "")}/`).toString();

export const getMcpProtectedResourceMetadata = (mode: McpMode = "default") => ({
  resource: getMcpResourceUrl(mode),
  resource_name: RESOURCE_NAME,
  resource_logo_uri: getResourceLogoUri(),
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
      maximum: STELLA_CLI_MAXIMUM_VERSION,
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
const MCP_CHALLENGE_ERRORS = ["none", "invalid_token"] as const;
export type McpChallengeError = (typeof MCP_CHALLENGE_ERRORS)[number];

/** Auth params preceding `resource_metadata`; each non-empty one ends in its separator. */
const CHALLENGE_ERROR_PARAMS = {
  none: "",
  invalid_token:
    'error="invalid_token", error_description="The access token is expired, revoked, or not valid for this resource", ',
} as const satisfies Record<McpChallengeError, string>;

export const getMcpWwwAuthenticateHeader = ({
  error = "none",
  mode = "default",
}: { error?: McpChallengeError; mode?: McpMode } = {}) =>
  `Bearer ${CHALLENGE_ERROR_PARAMS[error]}resource_metadata="${getMcpProtectedResourceMetadataUrl(mode)}"`;
