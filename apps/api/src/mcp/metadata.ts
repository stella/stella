import { env } from "@/api/env";
import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import type { McpMode } from "@/api/mcp/constants";
import {
  getMcpResourceScopes,
  getMcpProtectedResourceMetadataUrl,
  getMcpResourceUrl,
  MCP_ALLOWED_HEADERS,
  MCP_EXPOSE_HEADERS,
} from "@/api/mcp/constants";

export const createMcpMetadataHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS.join(", "),
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS.join(", "),
    "Cache-Control": "public, max-age=300",
  });

export const createMcpCorsHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS.join(", "),
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS.join(", "),
    "Access-Control-Max-Age": "86400",
  });

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
});

export const getMcpWwwAuthenticateHeader = (mode: McpMode = "default") =>
  `Bearer resource_metadata="${getMcpProtectedResourceMetadataUrl(mode)}"`;
