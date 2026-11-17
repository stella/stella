import packageJson from "../package.json" with { type: "json" };
import { CLI_REQUIRED_RESOURCE_SCOPES } from "../src/auth/constants.js";
import {
  CLI_MINIMUM_SERVER_REVISION,
  CLI_REQUIRED_CAPABILITIES,
  CLI_SUPPORTED_API_PROTOCOLS,
} from "../src/generated/api-contract.js";
import {
  MCP_DISCOVERY_PATH,
  MCP_HTTP_PATH,
} from "../src/generated/mcp-contract.js";

/**
 * Answer the public compatibility discovery request that the CLI makes before
 * remote commands, advertising exactly this package's contract and version.
 * Returns null for every other request.
 */
export const respondToCompatibilityDiscovery = (
  request: Request,
): Response | null => {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== MCP_DISCOVERY_PATH) {
    return null;
  }
  const protocol = Math.max(...CLI_SUPPORTED_API_PROTOCOLS);
  return Response.json({
    resource: new URL(MCP_HTTP_PATH, url.origin).toString(),
    scopes_supported: CLI_REQUIRED_RESOURCE_SCOPES,
    stella_contract: {
      protocol,
      revision: CLI_MINIMUM_SERVER_REVISION,
      capabilities: CLI_REQUIRED_CAPABILITIES,
    },
    stella_compatibility: {
      api_contract_version: protocol,
      cli_version: {
        minimum: packageJson.version,
        maximum: packageJson.version,
      },
    },
  });
};
