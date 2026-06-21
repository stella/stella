import { env } from "@/api/env";
import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import type { McpMode } from "@/api/mcp/constants";
import {
  getMcpResourceScopes,
  getMcpProtectedResourceMetadataUrl,
  getMcpResourceUrl,
  MCP_ALLOWED_HEADERS,
  MCP_EXPOSE_HEADERS,
  STELLA_CLI_LATEST_HEADER,
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MAXIMUM_VERSION,
  STELLA_CLI_MINIMUM_HEADER,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_HEADER,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";

export const createMcpMetadataHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS.join(", "),
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS.join(", "),
    "Cache-Control": "public, max-age=300",
    [STELLA_MCP_API_CONTRACT_HEADER]: String(STELLA_MCP_API_CONTRACT_VERSION),
    [STELLA_CLI_MINIMUM_HEADER]: STELLA_CLI_MINIMUM_VERSION,
    [STELLA_CLI_LATEST_HEADER]: STELLA_CLI_LATEST_VERSION,
  });

export const createMcpCorsHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS.join(", "),
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS.join(", "),
    "Access-Control-Max-Age": "86400",
    [STELLA_MCP_API_CONTRACT_HEADER]: String(STELLA_MCP_API_CONTRACT_VERSION),
    [STELLA_CLI_MINIMUM_HEADER]: STELLA_CLI_MINIMUM_VERSION,
    [STELLA_CLI_LATEST_HEADER]: STELLA_CLI_LATEST_VERSION,
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
  // RFC 9728 permits additional protected-resource metadata parameters and
  // requires clients to ignore ones they do not understand. Keeping Stella's
  // release contract in one extension preserves the standard OAuth fields.
  stella_compatibility: {
    api_contract_version: STELLA_MCP_API_CONTRACT_VERSION,
    cli_version: {
      minimum: STELLA_CLI_MINIMUM_VERSION,
      maximum: STELLA_CLI_MAXIMUM_VERSION,
    },
  },
});

export const getMcpWwwAuthenticateHeader = (mode: McpMode = "default") =>
  `Bearer resource_metadata="${getMcpProtectedResourceMetadataUrl(mode)}"`;
