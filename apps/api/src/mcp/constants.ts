import { env } from "@/api/env";

export const MCP_DEFAULT_RESOURCE_SCOPES = [
  "stella:search",
  "stella:read",
] as const;

export const MCP_ANONYMIZED_RESOURCE_SCOPES = [
  "stella:search_anonymized",
  "stella:read_anonymized",
] as const;

export const MCP_ALL_RESOURCE_SCOPES = [
  ...MCP_DEFAULT_RESOURCE_SCOPES,
  ...MCP_ANONYMIZED_RESOURCE_SCOPES,
] as const;

export const MCP_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  ...MCP_ALL_RESOURCE_SCOPES,
] as const;

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

export const MCP_EXPOSE_HEADERS = ["WWW-Authenticate"] as const;

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
