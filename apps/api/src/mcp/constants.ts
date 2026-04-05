import { env } from "@/api/env";

export const MCP_RESOURCE_SCOPES = ["stella:search", "stella:read"] as const;

export const MCP_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  ...MCP_RESOURCE_SCOPES,
] as const;

export const MCP_HTTP_PATH = "/mcp";

export const ROOT_MCP_DISCOVERY_PATH =
  "/.well-known/oauth-protected-resource" as const;

export const MCP_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_HTTP_PATH}` as const;

export const MCP_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "MCP-Protocol-Version",
] as const;

export const MCP_EXPOSE_HEADERS = ["WWW-Authenticate"] as const;

export const getMcpBaseUrl = () => env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

export const getMcpResourceUrl = () =>
  new URL(MCP_HTTP_PATH, `${getMcpBaseUrl().replace(/\/$/, "")}/`).toString();

export const getMcpProtectedResourceMetadataUrl = () =>
  new URL(
    MCP_DISCOVERY_PATH,
    `${getMcpBaseUrl().replace(/\/$/, "")}/`,
  ).toString();
