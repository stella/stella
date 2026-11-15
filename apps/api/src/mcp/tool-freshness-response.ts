import { MCP_REGISTRY_VERSION_HEADER } from "@stll/api-contract/mcp-registry";

import { rebuildResponse } from "@/api/lib/observability/server-error-answer";

export const withMcpRegistryVersionHeader = (
  response: Response,
  registryVersion: string | undefined,
): Response => {
  if (registryVersion === undefined) {
    return response;
  }
  const rebuilt = rebuildResponse(response, response.body);
  rebuilt.headers.set(MCP_REGISTRY_VERSION_HEADER, registryVersion);
  return rebuilt;
};
