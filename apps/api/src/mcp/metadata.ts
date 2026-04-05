import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import {
  getMcpProtectedResourceMetadataUrl,
  getMcpResourceUrl,
  MCP_ALLOWED_HEADERS,
  MCP_EXPOSE_HEADERS,
  MCP_RESOURCE_SCOPES,
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

export const getMcpProtectedResourceMetadata = () => ({
  resource: getMcpResourceUrl(),
  authorization_servers: [getAuthIssuerUrl()],
  scopes_supported: [...MCP_RESOURCE_SCOPES],
  bearer_methods_supported: ["header"],
});

export const getMcpWwwAuthenticateHeader = () =>
  `Bearer resource_metadata="${getMcpProtectedResourceMetadataUrl()}"`;
