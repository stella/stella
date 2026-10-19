import type { Context } from "elysia";

import {
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
} from "@/api/lib/auth/auth-paths";
import {
  applyResponseCachePolicy,
  DISCOVERY_METADATA_CACHE_POLICY,
} from "@/api/lib/security-headers";
import {
  MCP_RESOURCE_MODE_CONFIG,
  ROOT_MCP_DISCOVERY_PATH,
} from "@/api/mcp/resource-policy-contract";

export const DISCOVERY_METADATA_PATHS = new Set<string>([
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_MCP_DISCOVERY_PATH,
  ...Object.values(MCP_RESOURCE_MODE_CONFIG).map(
    ({ discoveryPath }) => discoveryPath,
  ),
]);

export const applyDiscoveryMetadataCachePolicy = ({
  request,
  set,
}: {
  request: Request;
  set: Context["set"];
}) => {
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    !DISCOVERY_METADATA_PATHS.has(new URL(request.url).pathname)
  ) {
    return;
  }
  applyResponseCachePolicy({
    cache: DISCOVERY_METADATA_CACHE_POLICY,
    response: undefined,
    set,
  });
};
