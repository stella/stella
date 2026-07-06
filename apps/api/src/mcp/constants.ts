import { env } from "@/api/env";

export const MCP_DEFAULT_RESOURCE_SCOPES = [
  "stella:search",
  "stella:read",
  "stella:templates",
  "stella:documents_write",
  "stella:matters_write",
  "stella:knowledge_write",
  "stella:billing_write",
  "stella:admin_read",
  "stella:admin_write",
  "stella:onboarding",
  "stella:skills",
  "stella:external_mcps",
] as const;

export const MCP_ANONYMIZED_RESOURCE_SCOPES = [
  "stella:search_anonymized",
  "stella:read_anonymized",
  "stella:templates_anonymized",
] as const;

export const MCP_ALL_RESOURCE_SCOPES = [
  ...MCP_DEFAULT_RESOURCE_SCOPES,
  ...MCP_ANONYMIZED_RESOURCE_SCOPES,
] as const;

export const MCP_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  // Protocol scope (RFC 6749 / OIDC), not a stella resource scope: it must
  // never leak into `MCP_ALL_RESOURCE_SCOPES` or the resource-metadata scope
  // lists derived from it. Granting it is what makes
  // `oauthProvider({ scopes: ... })` in `lib/auth.ts` issue a refresh token
  // alongside the access token.
  "offline_access",
  ...MCP_ALL_RESOURCE_SCOPES,
] as const;

/**
 * Every scope the OAuth provider can grant (see `oauthProvider({ scopes: ... })`
 * in `lib/auth.ts`). The consent page types its scope-label map against this
 * union so a newly added scope fails the build instead of silently rendering
 * without a disclosure line.
 */
export type McpOAuthScope = (typeof MCP_OAUTH_SCOPES)[number];

export const MCP_HTTP_PATH = "/mcp";
export const MCP_ANONYMIZED_HTTP_PATH = "/mcp-anonymized";

export const ROOT_MCP_DISCOVERY_PATH =
  "/.well-known/oauth-protected-resource" as const;

export const MCP_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_HTTP_PATH}` as const;

export const MCP_ANONYMIZED_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_ANONYMIZED_HTTP_PATH}` as const;

export const MCP_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "MCP-Protocol-Version",
] as const;

// Feeds the @stll/cli update nudge: the CLI reads `x-stella-cli-latest` off its
// runtime `tools/list` fetch and, if this is newer than the running CLI, prints
// one stderr hint. Bump this line when publishing a new @stll/cli. The header
// name is mirrored (by design, no shared module) in
// `packages/cli/src/cli-version-nudge.ts`.
export const STELLA_CLI_LATEST_VERSION = "0.1.0";
export const STELLA_CLI_LATEST_HEADER = "x-stella-cli-latest";

export const MCP_EXPOSE_HEADERS = [
  "WWW-Authenticate",
  STELLA_CLI_LATEST_HEADER,
] as const;

const MCP_MODE_CONFIG = {
  default: {
    discoveryPath: MCP_DISCOVERY_PATH,
    httpPath: MCP_HTTP_PATH,
    resourceScopes: MCP_DEFAULT_RESOURCE_SCOPES,
  },
  anonymized: {
    discoveryPath: MCP_ANONYMIZED_DISCOVERY_PATH,
    httpPath: MCP_ANONYMIZED_HTTP_PATH,
    resourceScopes: MCP_ANONYMIZED_RESOURCE_SCOPES,
  },
} as const;

export type McpMode = keyof typeof MCP_MODE_CONFIG;

const getMcpModeConfig = (mode: McpMode) => MCP_MODE_CONFIG[mode];

export const getMcpResourceScopes = (mode: McpMode) =>
  getMcpModeConfig(mode).resourceScopes;

export const getMcpBaseUrl = () => env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

export const getMcpResourceUrl = (mode: McpMode = "default") =>
  new URL(
    getMcpModeConfig(mode).httpPath,
    `${getMcpBaseUrl().replace(/\/$/u, "")}/`,
  ).toString();

export const getMcpProtectedResourceMetadataUrl = (mode: McpMode = "default") =>
  new URL(
    getMcpModeConfig(mode).discoveryPath,
    `${getMcpBaseUrl().replace(/\/$/u, "")}/`,
  ).toString();
